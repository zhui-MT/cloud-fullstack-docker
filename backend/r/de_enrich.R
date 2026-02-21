args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2) {
  stop("usage: Rscript de_enrich.R <input.json> <output.json>")
}

input_path <- args[[1]]
output_path <- args[[2]]

suppressPackageStartupMessages({
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    stop("jsonlite is required")
  }
})

script_args <- commandArgs(trailingOnly = FALSE)
script_file_arg <- script_args[grep("^--file=", script_args)][1]
if (is.na(script_file_arg)) {
  stop("cannot resolve script path for loading analysis.R")
}
script_path <- normalizePath(sub("^--file=", "", script_file_arg))
source(file.path(dirname(script_path), "analysis.R"), local = TRUE)

payload_root <- jsonlite::fromJSON(input_path, simplifyVector = FALSE)
output <- run_de_enrich_pipeline(payload_root)
jsonlite::write_json(output, output_path, auto_unbox = TRUE, pretty = TRUE, null = "null")
cat("de_enrich pipeline done\n")
