FROM rocker/r-ver:4.3.3

ARG R_ENGINE_CRAN_REPO=https://cloud.r-project.org
ARG R_ENGINE_INSTALL_ENRICHMENT_PACKAGES=0

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gfortran \
    curl \
    ca-certificates \
    libcurl4-openssl-dev \
    libssl-dev \
    libxml2-dev \
    zlib1g-dev \
    libgit2-dev \
    libfontconfig1-dev \
    libharfbuzz-dev \
    libfribidi-dev \
    libfreetype6-dev \
    libpng-dev \
    libtiff5-dev \
    libjpeg-dev \
    libsodium-dev \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    for i in 1 2 3; do \
      R -q -e "options(timeout=600); install.packages(c('BiocManager','plumber','jsonlite','R6','sodium','promises','httpuv'), repos='${R_ENGINE_CRAN_REPO}')"; \
      status=$?; \
      if [ "$status" -eq 0 ]; then break; fi; \
      if [ "$i" -eq 3 ]; then exit "$status"; fi; \
      sleep 5; \
    done; \
    for i in 1 2 3; do \
      R -q -e "options(timeout=600); BiocManager::install('limma', ask=FALSE, update=FALSE)"; \
      status=$?; \
      if [ "$status" -eq 0 ]; then break; fi; \
      if [ "$i" -eq 3 ]; then exit "$status"; fi; \
      sleep 5; \
    done; \
    if [ "$R_ENGINE_INSTALL_ENRICHMENT_PACKAGES" = "1" ]; then \
      for i in 1 2 3; do \
        R -q -e "options(timeout=600); BiocManager::install(c('clusterProfiler','org.Hs.eg.db'), ask=FALSE, update=FALSE)"; \
        status=$?; \
        if [ "$status" -eq 0 ]; then break; fi; \
        if [ "$i" -eq 3 ]; then exit "$status"; fi; \
        sleep 5; \
      done; \
      R -q -e "pkgs <- c('BiocManager','plumber','jsonlite','R6','sodium','promises','httpuv','limma','clusterProfiler','org.Hs.eg.db'); missing <- pkgs[!vapply(pkgs, requireNamespace, quietly=TRUE, FUN.VALUE=logical(1))]; if (length(missing)) stop(paste('missing packages:', paste(missing, collapse=', ')))"; \
    else \
      R -q -e "pkgs <- c('BiocManager','plumber','jsonlite','R6','sodium','promises','httpuv','limma'); missing <- pkgs[!vapply(pkgs, requireNamespace, quietly=TRUE, FUN.VALUE=logical(1))]; if (length(missing)) stop(paste('missing packages:', paste(missing, collapse=', ')))"; \
    fi

WORKDIR /app
COPY services/r-engine/app.R /app/app.R
COPY services/api/r/analysis.R /app/analysis.R

EXPOSE 8000
CMD ["R", "-e", "pr <- plumber::pr('/app/app.R'); pr$run(host='0.0.0.0', port=8000)"]
