args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) {
  stop("analysis script path argument is required")
}

analysis_path <- normalizePath(args[[1]], mustWork = FALSE)
if (!file.exists(analysis_path)) {
  stop(paste0("analysis script not found: ", analysis_path))
}
if (!requireNamespace("jsonlite", quietly = TRUE)) {
  stop("jsonlite package is required")
}

source(analysis_path)

stdin_conn <- file("stdin")
raw <- paste(readLines(stdin_conn, warn = FALSE), collapse = "")
if (is.null(raw) || nchar(raw) == 0) {
  stop("request body is required")
}

payload_root <- jsonlite::fromJSON(raw, simplifyVector = FALSE)
result <- run_de_enrich_pipeline(payload_root)

out <- list(
  ok = TRUE,
  meta = list(
    mode = as.character(payload_root$mode),
    service = "local-rscript",
    timestamp = as.character(Sys.time())
  ),
  result = result
)

cat(jsonlite::toJSON(out, auto_unbox = TRUE, null = "null", digits = NA))
