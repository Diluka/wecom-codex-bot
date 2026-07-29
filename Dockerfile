FROM denoland/deno

RUN --mount=type=cache,id=wecom-codex-bot-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=wecom-codex-bot-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  rm -f /etc/apt/apt.conf.d/docker-clean \
  && apt-get update \
  && apt-get install --yes --no-install-recommends \
    ca-certificates \
    git \
    openssh-client \
    ripgrep

RUN groupadd --gid 1000 bot \
  && useradd --uid 1000 --gid bot --create-home --shell /bin/bash bot

ENV HOME=/home/bot \
  DENO_DIR=/home/bot/.cache/deno \
  DENO_INSTALL_ROOT=/home/bot/.deno \
  NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
  PATH=/home/bot/.deno/bin:${PATH}

WORKDIR /app
RUN mkdir -p /app/.data "${DENO_DIR}" \
  && chown -R bot:bot /app /home/bot

USER bot
RUN --mount=type=cache,id=wecom-codex-bot-deno,target=/tmp/deno-cache,uid=1000,gid=1000,sharing=locked \
  DENO_DIR=/tmp/deno-cache deno install --global \
    --minimum-dependency-age=0 --allow-all "npm:@openai/codex" \
  && cp -a /tmp/deno-cache/. "${DENO_DIR}/"

COPY --chown=bot:bot . .

RUN --mount=type=cache,id=wecom-codex-bot-deno,target=/tmp/deno-cache,uid=1000,gid=1000,sharing=locked \
  DENO_DIR=/tmp/deno-cache deno cache --frozen --lock=deno.lock main.ts \
  && cp -a /tmp/deno-cache/. "${DENO_DIR}/"

STOPSIGNAL SIGTERM
CMD ["deno", "task", "start"]
