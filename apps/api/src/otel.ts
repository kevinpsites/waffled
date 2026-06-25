// OpenTelemetry preload. Loaded via NODE_OPTIONS=--require=/app/dist/otel.js BEFORE
// dist/server.js, so auto-instrumentation can patch real require() calls (notably
// node:http for request spans). Kept OUT of the server bundle (@opentelemetry/* are
// esbuild-external) because bundling defeats the require-time hooks.
//
// Completely OFF and ~zero cost unless OTEL_EXPORTER_OTLP_ENDPOINT is set — then it
// exports OTLP traces + metrics to that collector (e.g. the local grafana/otel-lgtm
// stack via `./nook observability up`). OTEL_SDK_DISABLED=true is a hard kill switch.
/* eslint-disable @typescript-eslint/no-var-requires */
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
if (endpoint && process.env.OTEL_SDK_DISABLED !== 'true') {
  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node')
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node')
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto')
    const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto')
    const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics')

    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter(), // reads OTEL_EXPORTER_OTLP_ENDPOINT
      metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // fs spans are extremely noisy and not useful here.
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    })
    sdk.start()
    process.on('SIGTERM', () => {
      sdk.shutdown().catch(() => {})
    })
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'otel started', endpoint }))
  } catch (err) {
    // Never let telemetry break the app — log and run uninstrumented.
    console.error('otel init failed; continuing without telemetry', err)
  }
}
