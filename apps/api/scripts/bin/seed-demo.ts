import { withSecrets } from '../../src/platform/bootstrap-secrets'

withSecrets('seed-demo', async () => {
  const { main } = await import('../seed-demo')
  await main()
})
