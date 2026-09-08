// Package configenv owns config.env — the native equivalent of infra/compose/.env.
//
// It is a line-oriented reader/writer rather than a map dump on purpose: an operator
// may hand-edit the file (an AI provider key, a Google client secret), and rewriting
// it must not throw away their comments, ordering, or keys this binary knows nothing
// about. The secret generation mirrors `ensure_env` in the repo-root `waffled` script
// byte-format for byte-format, because the same api binary validates them.
package configenv

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/kevinpsites/waffled/apps/runtime/internal/atomicfile"
)

// The keys this binary reads or writes. Everything else in the file is passed through.
const (
	KeyLocalJWTSecret         = "LOCAL_JWT_SECRET"
	KeyTokenEncryptionKey     = "TOKEN_ENCRYPTION_KEY"
	KeyPostgresPassword       = "POSTGRES_PASSWORD"
	KeyPowerSyncJWTPrivateKey = "POWERSYNC_JWT_PRIVATE_KEY"
	KeyPostgresUser           = "POSTGRES_USER"
	KeyPostgresDB             = "POSTGRES_DB"
)

// The placeholder values .env.example ships; the api refuses to start on either.
const (
	developmentJWTSecret     = "waffled-local-dev-secret-change-me"
	placeholderPGPassword    = "change-me"
	defaultPostgresUser      = "waffled"
	defaultPostgresDatabase  = "waffled"
	localJWTSecretBytes      = 48
	tokenEncryptionKeyBytes  = 32
	postgresPasswordHexBytes = 24
	rsaKeyBits               = 2048
)

// requiredSecrets is the same list `waffled ensure_env` insists on.
var requiredSecrets = []string{
	KeyLocalJWTSecret,
	KeyTokenEncryptionKey,
	KeyPostgresPassword,
	KeyPowerSyncJWTPrivateKey,
}

type line struct {
	raw   string // verbatim text for comments/blanks
	key   string // "" when this line is not an assignment
	value string
}

// Env is a parsed config.env. The zero value is not useful; call Load.
type Env struct {
	lines []line
	index map[string]int // key → position in lines
}

// Load reads config.env. A missing file is not an error — it is what "first run" looks
// like, and the caller then calls EnsureSecrets and Save.
func Load(path string) (*Env, error) {
	e := &Env{index: map[string]int{}}
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return e, nil
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024) // the RSA key line is ~2.3 KB
	for sc.Scan() {
		text := sc.Text()
		trimmed := strings.TrimSpace(text)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			e.lines = append(e.lines, line{raw: text})
			continue
		}
		k, v, found := strings.Cut(text, "=")
		if !found {
			e.lines = append(e.lines, line{raw: text})
			continue
		}
		key := strings.TrimSpace(k)
		e.index[key] = len(e.lines)
		e.lines = append(e.lines, line{key: key, value: v})
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return e, nil
}

// Get returns the value for key, or "" when it is absent.
func (e *Env) Get(key string) string {
	i, ok := e.index[key]
	if !ok {
		return ""
	}
	return e.lines[i].value
}

// Set assigns key in place when it already exists, else appends it.
func (e *Env) Set(key, value string) {
	if i, ok := e.index[key]; ok {
		e.lines[i].value = value
		return
	}
	e.index[key] = len(e.lines)
	e.lines = append(e.lines, line{key: key, value: value})
}

// All returns a copy of every assignment, for diagnostics.
func (e *Env) All() map[string]string {
	out := make(map[string]string, len(e.index))
	for k, i := range e.index {
		out[k] = e.lines[i].value
	}
	return out
}

// Save writes the file atomically at 0600, through atomicfile: a temp file in the same
// directory, fsynced before the rename, so neither a crash nor a power cut can leave a
// half-written secret store. It tightens the mode even if the file had been loosened.
func (e *Env) Save(path string) error {
	var buf bytes.Buffer
	for _, l := range e.lines {
		if l.key == "" {
			buf.WriteString(l.raw)
		} else {
			buf.WriteString(l.key)
			buf.WriteByte('=')
			buf.WriteString(l.value)
		}
		buf.WriteByte('\n')
	}
	return atomicfile.WriteFile(path, buf.Bytes(), 0o600)
}

// EnsureSecrets fills in any missing secret and the Postgres role/database defaults,
// leaving anything already present untouched. It returns the keys it generated so the
// caller can log "first run" honestly. Formats match `waffled ensure_env` exactly:
//
//	LOCAL_JWT_SECRET          openssl rand -base64 48
//	TOKEN_ENCRYPTION_KEY      openssl rand -base64 32
//	POSTGRES_PASSWORD         openssl rand -hex 24   (URL-safe: it goes into postgres:// URLs)
//	POWERSYNC_JWT_PRIVATE_KEY openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 | openssl base64 -A
func (e *Env) EnsureSecrets() ([]string, error) {
	var generated []string

	if e.Get(KeyLocalJWTSecret) == "" {
		v, err := randomBase64(localJWTSecretBytes)
		if err != nil {
			return nil, err
		}
		e.Set(KeyLocalJWTSecret, v)
		generated = append(generated, KeyLocalJWTSecret)
	}
	if e.Get(KeyTokenEncryptionKey) == "" {
		v, err := randomBase64(tokenEncryptionKeyBytes)
		if err != nil {
			return nil, err
		}
		e.Set(KeyTokenEncryptionKey, v)
		generated = append(generated, KeyTokenEncryptionKey)
	}
	if e.Get(KeyPostgresPassword) == "" || e.Get(KeyPostgresPassword) == placeholderPGPassword {
		v, err := randomHex(postgresPasswordHexBytes)
		if err != nil {
			return nil, err
		}
		e.Set(KeyPostgresPassword, v)
		generated = append(generated, KeyPostgresPassword)
	}
	if e.Get(KeyPowerSyncJWTPrivateKey) == "" {
		v, err := generateRSAPrivateKeyBase64()
		if err != nil {
			return nil, err
		}
		e.Set(KeyPowerSyncJWTPrivateKey, v)
		generated = append(generated, KeyPowerSyncJWTPrivateKey)
	}
	if e.Get(KeyPostgresUser) == "" {
		e.Set(KeyPostgresUser, defaultPostgresUser)
	}
	if e.Get(KeyPostgresDB) == "" {
		e.Set(KeyPostgresDB, defaultPostgresDatabase)
	}
	return generated, nil
}

// Validate reproduces the checks `waffled ensure_env` makes before handing the values
// to a service, so a bad hand-edit fails here with a clear message instead of inside
// Node's "Invalid production secrets" a few seconds later.
func (e *Env) Validate() error {
	var problems []string
	for _, key := range requiredSecrets {
		if e.Get(key) == "" {
			problems = append(problems, key+" is missing")
		}
	}
	if e.Get(KeyLocalJWTSecret) == developmentJWTSecret {
		problems = append(problems, KeyLocalJWTSecret+" still uses the public development value")
	}
	if e.Get(KeyPostgresPassword) == placeholderPGPassword {
		problems = append(problems, KeyPostgresPassword+" still uses the example placeholder")
	}
	if v := e.Get(KeyLocalJWTSecret); v != "" && len(v) < 32 {
		problems = append(problems, KeyLocalJWTSecret+" must be at least 32 characters")
	}
	if v := e.Get(KeyTokenEncryptionKey); v != "" {
		if raw, err := base64.StdEncoding.DecodeString(v); err != nil || len(raw) != tokenEncryptionKeyBytes {
			problems = append(problems, KeyTokenEncryptionKey+" must be base64 of exactly 32 bytes")
		}
	}
	if v := e.Get(KeyPowerSyncJWTPrivateKey); v != "" {
		if err := checkRSAPrivateKey(v); err != nil {
			problems = append(problems, KeyPowerSyncJWTPrivateKey+" must be an RSA private key (PEM or base64 PEM): "+err.Error())
		}
	}
	if len(problems) == 0 {
		return nil
	}
	return fmt.Errorf("config.env is not usable:\n  - %s", strings.Join(problems, "\n  - "))
}

// DatabaseURL builds the postgres:// URL for a database on the loopback cluster.
// The password is hex by construction, so it needs no escaping — see EnsureSecrets.
func (e *Env) DatabaseURL(port int, database string) string {
	return fmt.Sprintf("postgres://%s:%s@127.0.0.1:%d/%s",
		e.Get(KeyPostgresUser), e.Get(KeyPostgresPassword), port, database)
}

// PostgresUser / PostgresDB are conveniences with the compose defaults applied.
func (e *Env) PostgresUser() string {
	if v := e.Get(KeyPostgresUser); v != "" {
		return v
	}
	return defaultPostgresUser
}

func (e *Env) PostgresDB() string {
	if v := e.Get(KeyPostgresDB); v != "" {
		return v
	}
	return defaultPostgresDatabase
}

func randomBase64(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate secret: %w", err)
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate secret: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// generateRSAPrivateKeyBase64 produces exactly what `openssl genpkey … | openssl base64 -A`
// produces: a PKCS#8 ("BEGIN PRIVATE KEY") PEM, base64'd onto a single line. Both the api's
// production-secret check and its PowerSync token minter accept that shape.
func generateRSAPrivateKeyBase64() (string, error) {
	key, err := rsa.GenerateKey(rand.Reader, rsaKeyBits)
	if err != nil {
		return "", fmt.Errorf("generate RSA key: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", fmt.Errorf("marshal RSA key: %w", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	return base64.StdEncoding.EncodeToString(pemBytes), nil
}

// checkRSAPrivateKey accepts either a raw PEM or a base64 of one, matching the api.
func checkRSAPrivateKey(value string) error {
	pemText := value
	if !strings.Contains(value, "BEGIN") {
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
		if err != nil {
			return errors.New("not base64")
		}
		pemText = string(raw)
	}
	block, _ := pem.Decode([]byte(pemText))
	if block == nil {
		return errors.New("no PEM block")
	}
	switch block.Type {
	case "PRIVATE KEY":
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return err
		}
		if _, ok := parsed.(*rsa.PrivateKey); !ok {
			return fmt.Errorf("key is %T, not RSA", parsed)
		}
	case "RSA PRIVATE KEY":
		if _, err := x509.ParsePKCS1PrivateKey(block.Bytes); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unexpected PEM block %q", block.Type)
	}
	return nil
}
