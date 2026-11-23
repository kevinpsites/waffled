import { withSecrets } from '../../src/platform/bootstrap-secrets'

withSecrets('admin', () => import('../admin'))
