source("/app/analysis.R")

#* @get /health
function() {
  list(ok = TRUE, service = "r-engine")
}

#* @get /
function() {
  list(message = "BioID r-engine is running")
}

#* Run differential + enrichment pipeline (limma + clusterProfiler)
#* @post /run/de-enrich
#* @serializer unboxedJSON
function(req, res) {
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    res$status <- 500
    return(list(ok = FALSE, error = "jsonlite package is required"))
  }

  body <- req$postBody
  if (is.raw(body)) {
    body <- rawToChar(body)
  }
  if (is.null(body) || nchar(body) == 0) {
    res$status <- 400
    return(list(ok = FALSE, error = "request body is required"))
  }

  payload_root <- tryCatch(
    jsonlite::fromJSON(body, simplifyVector = FALSE),
    error = function(e) {
      res$status <- 400
      list(`__json_error__` = e$message)
    }
  )

  if (!is.null(payload_root$`__json_error__`)) {
    return(list(ok = FALSE, error = paste0("invalid json: ", payload_root$`__json_error__`)))
  }

  result <- tryCatch(
    run_de_enrich_pipeline(payload_root),
    error = function(e) {
      res$status <- 500
      list(`__pipeline_error__` = e$message)
    }
  )

  if (!is.null(result$`__pipeline_error__`)) {
    return(list(ok = FALSE, error = result$`__pipeline_error__`))
  }

  list(
    ok = TRUE,
    meta = list(
      mode = as.character(payload_root$mode),
      service = "r-engine",
      timestamp = as.character(Sys.time())
    ),
    result = result
  )
}
