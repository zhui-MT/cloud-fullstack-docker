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

payload_root <- jsonlite::fromJSON(input_path, simplifyVector = FALSE)
mode <- payload_root$mode
payload <- payload_root$payload

need_pkg <- function(pkg) {
  if (!requireNamespace(pkg, quietly = TRUE)) {
    stop(paste0("required package missing: ", pkg))
  }
}

run_limma_de <- function(d) {
  need_pkg("limma")

  genes <- unlist(d$genes)
  mat_rows <- lapply(d$matrix, function(row) as.numeric(unlist(row$values)))
  mat <- do.call(rbind, mat_rows)
  rownames(mat) <- genes

  sample_df <- do.call(rbind, lapply(d$samples, function(s) {
    data.frame(sample = as.character(s$sample), group = as.character(s$group), stringsAsFactors = FALSE)
  }))

  group <- factor(sample_df$group)
  group_a <- as.character(d$de$groupA)
  group_b <- as.character(d$de$groupB)

  if (!(group_a %in% levels(group)) || !(group_b %in% levels(group))) {
    stop("groupA/groupB not found in samples")
  }

  design <- stats::model.matrix(~ 0 + group)
  colnames(design) <- levels(group)
  contrast_str <- paste0(group_b, "-", group_a)

  fit <- limma::lmFit(mat, design)
  contrast <- limma::makeContrasts(contrasts = contrast_str, levels = design)
  fit2 <- limma::eBayes(limma::contrasts.fit(fit, contrast))
  tt <- limma::topTable(fit2, number = Inf, sort.by = "P")
  tt$gene <- rownames(tt)

  tt <- tt[, c("gene", "logFC", "P.Value", "adj.P.Val")]
  colnames(tt) <- c("gene", "logFC", "pvalue", "adjPValue")

  tt$logFC <- round(tt$logFC, 6)
  tt$pvalue <- round(tt$pvalue, 12)
  tt$adjPValue <- round(tt$adjPValue, 12)

  log2fc <- as.numeric(d$de$log2fcThreshold)
  padj <- as.numeric(d$de$padjThreshold)

  sig <- tt[abs(tt$logFC) >= log2fc & tt$adjPValue <= padj, , drop = FALSE]

  rows_to_list <- function(df) {
    if (nrow(df) == 0) {
      return(list())
    }
    out <- vector("list", nrow(df))
    for (i in seq_len(nrow(df))) {
      out[[i]] <- as.list(df[i, , drop = FALSE])
    }
    out
  }

  list(
    de = list(
      summary = list(
        totalGenes = nrow(tt),
        significantGenes = nrow(sig),
        thresholds = list(log2fc = log2fc, padj = padj)
      ),
      topTable = rows_to_list(tt[seq_len(min(nrow(tt), 50)), , drop = FALSE])
    ),
    significantGenes = sig$gene
  )
}

run_clusterprofiler <- function(sig_genes, pvalue_cutoff = 0.05, qvalue_cutoff = 0.2) {
  need_pkg("clusterProfiler")
  need_pkg("org.Hs.eg.db")

  if (length(sig_genes) == 0) {
    return(list(go = list(), kegg = list()))
  }

  mapped <- tryCatch({
    clusterProfiler::bitr(sig_genes,
                          fromType = "SYMBOL",
                          toType = "ENTREZID",
                          OrgDb = org.Hs.eg.db::org.Hs.eg.db)
  }, error = function(e) {
    data.frame(SYMBOL = character(), ENTREZID = character(), stringsAsFactors = FALSE)
  })

  if (nrow(mapped) == 0) {
    return(list(go = list(), kegg = list()))
  }

  entrez <- unique(mapped$ENTREZID)

  go_res <- tryCatch({
    clusterProfiler::enrichGO(
      gene = entrez,
      OrgDb = org.Hs.eg.db::org.Hs.eg.db,
      ont = "ALL",
      pvalueCutoff = pvalue_cutoff,
      qvalueCutoff = qvalue_cutoff,
      readable = TRUE
    )
  }, error = function(e) NULL)

  kegg_res <- tryCatch({
    clusterProfiler::enrichKEGG(
      gene = entrez,
      organism = "hsa",
      pvalueCutoff = pvalue_cutoff,
      qvalueCutoff = qvalue_cutoff
    )
  }, error = function(e) NULL)

  tidy_df <- function(df, db_name) {
    if (is.null(df) || nrow(df) == 0) {
      return(list())
    }
    keep <- df[, c("ID", "Description", "GeneRatio", "BgRatio", "pvalue", "p.adjust", "geneID"), drop = FALSE]
    colnames(keep) <- c("id", "description", "geneRatio", "bgRatio", "pvalue", "qvalue", "geneID")

    rows <- vector("list", nrow(keep))
    for (i in seq_len(nrow(keep))) {
      rows[[i]] <- list(
        db = db_name,
        id = as.character(keep$id[[i]]),
        description = as.character(keep$description[[i]]),
        geneRatio = as.character(keep$geneRatio[[i]]),
        bgRatio = as.character(keep$bgRatio[[i]]),
        pvalue = as.numeric(keep$pvalue[[i]]),
        qvalue = as.numeric(keep$qvalue[[i]]),
        genes = strsplit(as.character(keep$geneID[[i]]), "/")[[1]]
      )
    }
    rows
  }

  go_df <- if (is.null(go_res)) data.frame() else as.data.frame(go_res)
  kegg_df <- if (is.null(kegg_res)) data.frame() else as.data.frame(kegg_res)

  list(
    go = tidy_df(go_df, "GO"),
    kegg = tidy_df(kegg_df, "KEGG")
  )
}

output <- list()

if (mode == "de") {
  de_result <- run_limma_de(payload)
  output <- de_result
} else if (mode == "enrichment") {
  de_result <- run_limma_de(payload)
  enrich <- run_clusterprofiler(
    de_result$significantGenes,
    as.numeric(payload$enrichment$pvalueCutoff),
    as.numeric(payload$enrichment$qvalueCutoff)
  )
  output <- list(
    de = de_result$de,
    significantGenes = de_result$significantGenes,
    enrichment = enrich
  )
} else if (mode == "de-enrich") {
  de_result <- run_limma_de(payload)
  enrich <- run_clusterprofiler(
    de_result$significantGenes,
    as.numeric(payload$enrichment$pvalueCutoff),
    as.numeric(payload$enrichment$qvalueCutoff)
  )
  output <- list(
    de = de_result$de,
    significantGenes = de_result$significantGenes,
    enrichment = enrich
  )
} else {
  stop(paste0("unsupported mode: ", mode))
}

jsonlite::write_json(output, output_path, auto_unbox = TRUE, pretty = TRUE, null = "null")
cat("de_enrich pipeline done\n")
