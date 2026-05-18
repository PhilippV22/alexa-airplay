FROM ghcr.io/home-assistant/base:latest

ARG BUILD_VERSION=1.0.0
ARG BUILD_ARCH=amd64

LABEL \
  io.hass.name="AirBridge" \
  io.hass.description="AirPlay to Amazon Echo over Bluetooth" \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

RUN \
  apk add --no-cache \
    alsa-utils \
    bash \
    bluez \
    bluez-alsa \
    bluez-alsa-utils \
    jq \
    shairport-sync

COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
