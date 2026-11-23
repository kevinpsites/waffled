import { withSecrets } from '../../src/platform/bootstrap-secrets'

withSecrets('migrate', () => import('../migrate-cli'))
