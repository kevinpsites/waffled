# The PowerSync service with Waffled's sync rules baked in, so they travel with the
# release whose migrations they depend on: sync-config.yaml selects from tables created
# by migrations inside waffled-api, and a host-mounted copy can be a different version
# than the running api. The repo copies stay canonical — the native Mac bundle reads
# them straight out of infra/compose/powersync.
#
# Build context: infra/compose/powersync (see publish-images.yml).
FROM journeyapps/powersync-service:1.22.0

# service.yaml points at sync-config.yaml by a relative path, so both land together.
COPY service.yaml sync-config.yaml /config/
ENV POWERSYNC_CONFIG_PATH=/config/service.yaml
