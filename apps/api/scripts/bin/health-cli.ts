import { withSecrets } from '../../src/platform/bootstrap-secrets'

withSecrets('health-cli', () => import('../health-cli'))
