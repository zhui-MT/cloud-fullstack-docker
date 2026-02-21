#* @get /health
function() {
  list(ok = TRUE, service = 'r-engine')
}

#* @get /
function() {
  list(message = 'BioID r-engine is running')
}
