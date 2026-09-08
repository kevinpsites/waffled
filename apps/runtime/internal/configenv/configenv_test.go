package configenv

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadMissingFileIsEmpty(t *testing.T) {
	e, err := Load(filepath.Join(t.TempDir(), "config.env"))
	if err != nil {
		t.Fatalf("Load of a missing file must succeed, got %v", err)
	}
	if got := e.Get("LOCAL_JWT_SECRET"); got != "" {
		t.Fatalf("expected empty value, got %q", got)
	}
}

func TestRoundTripPreservesUnknownKeysAndComments(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.env")
	original := "# operator note\nOPERATOR_TWEAK=keep me\nLOCAL_JWT_SECRET=abc\n\n# trailing\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	e, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := e.Get("OPERATOR_TWEAK"); got != "keep me" {
		t.Fatalf("value with a space not parsed: %q", got)
	}
	e.Set("LOCAL_JWT_SECRET", "replaced")
	e.Set("BRAND_NEW", "1")
	if err := e.Save(path); err != nil {
		t.Fatal(err)
	}
	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	for _, want := range []string{"# operator note", "OPERATOR_TWEAK=keep me", "LOCAL_JWT_SECRET=replaced", "BRAND_NEW=1", "# trailing"} {
		if !strings.Contains(text, want) {
			t.Errorf("saved file lost %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "LOCAL_JWT_SECRET=abc") {
		t.Errorf("old value survived the rewrite:\n%s", text)
	}
	// Reload must see the same thing.
	again, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if again.Get("LOCAL_JWT_SECRET") != "replaced" || again.Get("OPERATOR_TWEAK") != "keep me" {
		t.Fatalf("round trip lost values: %#v", again.All())
	}
}

func TestSaveIsOwnerOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.env")
	e, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	e.Set("X", "1")
	if err := e.Save(path); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config.env must be 0600, got %o", perm)
	}
}

// Rewriting an existing file that somehow became group/world readable must repair it.
func TestSaveRepairsLoosePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.env")
	if err := os.WriteFile(path, []byte("A=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	e, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	e.Set("B", "2")
	if err := e.Save(path); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(path)
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Fatalf("Save must tighten permissions to 0600, got %o", perm)
	}
}

func TestEnsureSecretsGeneratesTheWaffledFormats(t *testing.T) {
	e, err := Load(filepath.Join(t.TempDir(), "config.env"))
	if err != nil {
		t.Fatal(err)
	}
	generated, err := e.EnsureSecrets()
	if err != nil {
		t.Fatal(err)
	}
	if len(generated) != 4 {
		t.Fatalf("expected the four secrets to be generated, got %v", generated)
	}

	// LOCAL_JWT_SECRET: base64 of 48 random bytes (openssl rand -base64 48).
	raw, err := base64.StdEncoding.DecodeString(e.Get(KeyLocalJWTSecret))
	if err != nil || len(raw) != 48 {
		t.Errorf("LOCAL_JWT_SECRET must be base64 of 48 bytes, got %d bytes / err %v", len(raw), err)
	}
	// The api rejects anything shorter than 32 characters, and the public dev value.
	if len(e.Get(KeyLocalJWTSecret)) < 32 {
		t.Errorf("LOCAL_JWT_SECRET too short for the api validator")
	}

	// TOKEN_ENCRYPTION_KEY: base64 of exactly 32 bytes, standard alphabet WITH padding —
	// the api validates /^[A-Za-z0-9+/]+={0,2}$/ and length%4==0.
	tok := e.Get(KeyTokenEncryptionKey)
	if len(tok)%4 != 0 {
		t.Errorf("TOKEN_ENCRYPTION_KEY length %d is not a multiple of 4 (api rejects)", len(tok))
	}
	if strings.ContainsAny(tok, "-_") {
		t.Errorf("TOKEN_ENCRYPTION_KEY must use the standard base64 alphabet, got %q", tok)
	}
	key, err := base64.StdEncoding.DecodeString(tok)
	if err != nil || len(key) != 32 {
		t.Errorf("TOKEN_ENCRYPTION_KEY must decode to 32 bytes, got %d / err %v", len(key), err)
	}

	// POSTGRES_PASSWORD: hex of 24 bytes — URL-safe, because it is interpolated into
	// postgres:// URLs (base64 '/' broke the one-shot migrate historically).
	pw := e.Get(KeyPostgresPassword)
	if len(pw) != 48 {
		t.Errorf("POSTGRES_PASSWORD must be 48 hex chars, got %d", len(pw))
	}
	if _, err := hex.DecodeString(pw); err != nil {
		t.Errorf("POSTGRES_PASSWORD must be hex: %v", err)
	}

	// POWERSYNC_JWT_PRIVATE_KEY: base64 of an RSA-2048 PKCS#8 PEM, one line.
	psk := e.Get(KeyPowerSyncJWTPrivateKey)
	if strings.ContainsAny(psk, "\n\r") {
		t.Errorf("POWERSYNC_JWT_PRIVATE_KEY must be a single line")
	}
	pemBytes, err := base64.StdEncoding.DecodeString(psk)
	if err != nil {
		t.Fatalf("POWERSYNC_JWT_PRIVATE_KEY must be base64: %v", err)
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil || block.Type != "PRIVATE KEY" {
		t.Fatalf("decoded value must be a PKCS#8 PEM, got %#v", block)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		t.Fatalf("PKCS#8 parse failed: %v", err)
	}
	rsaKey, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		t.Fatalf("key must be RSA, got %T", parsed)
	}
	if bits := rsaKey.N.BitLen(); bits != 2048 {
		t.Errorf("RSA key must be 2048-bit, got %d", bits)
	}

	// Role/database default to waffled, as compose does.
	if e.Get(KeyPostgresUser) != "waffled" || e.Get(KeyPostgresDB) != "waffled" {
		t.Errorf("POSTGRES_USER/DB should default to waffled, got %q/%q", e.Get(KeyPostgresUser), e.Get(KeyPostgresDB))
	}
}

func TestEnsureSecretsIsIdempotent(t *testing.T) {
	e, err := Load(filepath.Join(t.TempDir(), "config.env"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.EnsureSecrets(); err != nil {
		t.Fatal(err)
	}
	before := e.Get(KeyLocalJWTSecret)
	generated, err := e.EnsureSecrets()
	if err != nil {
		t.Fatal(err)
	}
	if len(generated) != 0 {
		t.Errorf("second EnsureSecrets must generate nothing, got %v", generated)
	}
	if e.Get(KeyLocalJWTSecret) != before {
		t.Errorf("EnsureSecrets rotated an existing secret")
	}
}

func TestValidateRejectsPlaceholders(t *testing.T) {
	e, _ := Load(filepath.Join(t.TempDir(), "config.env"))
	if _, err := e.EnsureSecrets(); err != nil {
		t.Fatal(err)
	}
	if err := e.Validate(); err != nil {
		t.Fatalf("freshly generated secrets must validate: %v", err)
	}

	e.Set(KeyPostgresPassword, "change-me")
	if err := e.Validate(); err == nil {
		t.Error("the example placeholder password must be refused")
	}

	e2, _ := Load(filepath.Join(t.TempDir(), "config.env"))
	if _, err := e2.EnsureSecrets(); err != nil {
		t.Fatal(err)
	}
	e2.Set(KeyLocalJWTSecret, "waffled-local-dev-secret-change-me")
	if err := e2.Validate(); err == nil {
		t.Error("the public development secret must be refused")
	}

	e3, _ := Load(filepath.Join(t.TempDir(), "config.env"))
	if err := e3.Validate(); err == nil {
		t.Error("missing secrets must be refused")
	}
}

// A password containing URL-reserved characters would silently corrupt DATABASE_URL,
// so the generated one must survive being embedded verbatim.
func TestDatabaseURLIsBuiltFromConfig(t *testing.T) {
	e, _ := Load(filepath.Join(t.TempDir(), "config.env"))
	if _, err := e.EnsureSecrets(); err != nil {
		t.Fatal(err)
	}
	got := e.DatabaseURL(5433, e.Get(KeyPostgresDB))
	want := "postgres://waffled:" + e.Get(KeyPostgresPassword) + "@127.0.0.1:5433/waffled"
	if got != want {
		t.Fatalf("DatabaseURL() = %q, want %q", got, want)
	}
	if e.DatabaseURL(5433, "powersync_storage") != "postgres://waffled:"+e.Get(KeyPostgresPassword)+"@127.0.0.1:5433/powersync_storage" {
		t.Fatal("storage URL wrong")
	}
}
