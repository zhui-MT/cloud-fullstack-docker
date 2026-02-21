FROM rocker/r-ver:4.3.3

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN R -q -e "install.packages(c('plumber','jsonlite'), repos='https://cloud.r-project.org')"

WORKDIR /app
COPY app.R /app/app.R

EXPOSE 8000
CMD ["R", "-e", "plumber::pr('/app/app.R') |> pr_run(host='0.0.0.0', port=8000)"]
