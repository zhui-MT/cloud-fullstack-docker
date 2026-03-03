value_or_default <- function(value, fallback) {
  if (is.null(value) || length(value) == 0) {
    return(fallback)
  }
  value
}

value_or_na <- function(value) {
  if (is.null(value) || length(value) == 0) {
    return(NA_real_)
  }
  suppressWarnings(as.numeric(value))[1]
}

extract_sample_names <- function(d) {
  if (is.null(d$samples) || length(d$samples) == 0) {
    stop("samples are required")
  }
  vapply(d$samples, function(s) as.character(value_or_default(s$sample, "sample")), character(1))
}

extract_gene_names <- function(d) {
  if (!is.null(d$genes) && length(d$genes) == length(d$matrix)) {
    return(vapply(d$genes, function(g) as.character(g), character(1)))
  }
  vapply(
    d$matrix,
    function(row) as.character(value_or_default(row$gene, "gene")),
    character(1)
  )
}

row_values_numeric <- function(values, expected_length) {
  out <- rep(NA_real_, expected_length)
  if (is.null(values) || length(values) == 0) {
    return(out)
  }
  upper <- min(length(values), expected_length)
  for (i in seq_len(upper)) {
    out[[i]] <- value_or_na(values[[i]])
  }
  out
}

build_expression_matrix <- function(d) {
  sample_names <- extract_sample_names(d)
  genes <- extract_gene_names(d)
  sample_count <- length(sample_names)
  rows <- lapply(d$matrix, function(row) row_values_numeric(row$values, sample_count))
  mat <- do.call(rbind, rows)
  if (is.null(dim(mat))) {
    mat <- matrix(mat, nrow = 1)
  }
  rownames(mat) <- genes
  colnames(mat) <- sample_names
  mat
}

matrix_to_payload <- function(d, mat) {
  genes <- rownames(mat)
  matrix_rows <- vector("list", nrow(mat))
  for (i in seq_len(nrow(mat))) {
    matrix_rows[[i]] <- list(
      gene = as.character(genes[[i]]),
      values = as.list(as.numeric(mat[i, ]))
    )
  }

  d$genes <- as.list(genes)
  d$matrix <- matrix_rows
  d
}

matrix_stats <- function(mat) {
  finite <- as.numeric(mat[is.finite(mat)])
  if (length(finite) == 0) {
    return(list(
      mean = 0,
      sd = 1e-6,
      min = 0,
      q = stats::quantile(c(0), probs = c(0.01, 0.25, 0.75), na.rm = TRUE)
    ))
  }
  s <- stats::sd(finite)
  if (is.na(s) || s < 1e-6) {
    s <- 1e-6
  }
  list(
    mean = mean(finite),
    sd = s,
    min = min(finite),
    q = stats::quantile(finite, probs = c(0.01, 0.25, 0.75), na.rm = TRUE)
  )
}

impute_min_half <- function(mat) {
  imputed <- 0
  for (i in seq_len(nrow(mat))) {
    miss <- which(!is.finite(mat[i, ]))
    if (length(miss) == 0) next
    finite <- mat[i, is.finite(mat[i, ])]
    if (length(finite) == 0) next
    fill <- min(finite) / 2
    mat[i, miss] <- fill
    imputed <- imputed + length(miss)
  }
  list(mat = mat, imputed = imputed)
}

impute_left_shift <- function(mat, downshift = 1.8, width = 0.3) {
  st <- matrix_stats(mat)
  imputed <- 0
  center <- st$mean - downshift * st$sd
  spread <- max(width * st$sd, 1e-6)
  idx <- which(!is.finite(mat), arr.ind = TRUE)
  if (nrow(idx) > 0) {
    mat[idx] <- stats::rnorm(nrow(idx), mean = center, sd = spread)
    imputed <- nrow(idx)
  }
  list(mat = mat, imputed = imputed)
}

impute_minprob <- function(mat, q = 0.01) {
  st <- matrix_stats(mat)
  q <- min(max(q, 0.0001), 0.5)
  floor_val <- as.numeric(stats::quantile(as.numeric(mat[is.finite(mat)]), probs = q, na.rm = TRUE))
  idx <- which(!is.finite(mat), arr.ind = TRUE)
  if (nrow(idx) > 0) {
    factor <- stats::runif(nrow(idx), min = 0.85, max = 1.15)
    mat[idx] <- floor_val * factor
  }
  list(mat = mat, imputed = nrow(idx))
}

impute_qrilc <- function(mat, tune_sigma = 1) {
  st <- matrix_stats(mat)
  q1 <- as.numeric(st$q[[2]])
  q3 <- as.numeric(st$q[[3]])
  iqr <- max(q3 - q1, 1e-6)
  center <- q1 - tune_sigma * 0.25 * iqr
  spread <- max(0.15 * iqr, 1e-6)
  idx <- which(!is.finite(mat), arr.ind = TRUE)
  if (nrow(idx) > 0) {
    sampled <- stats::rnorm(nrow(idx), mean = center, sd = spread)
    mat[idx] <- pmin(sampled, q1)
  }
  list(mat = mat, imputed = nrow(idx))
}

impute_column_stat <- function(mat, stat_fn) {
  imputed <- 0
  for (j in seq_len(ncol(mat))) {
    miss <- which(!is.finite(mat[, j]))
    if (length(miss) == 0) next
    finite <- mat[is.finite(mat[, j]), j]
    if (length(finite) == 0) next
    fill <- stat_fn(finite)
    mat[miss, j] <- fill
    imputed <- imputed + length(miss)
  }
  list(mat = mat, imputed = imputed)
}

impute_knn_like <- function(mat) {
  n <- nrow(mat)
  imputed <- 0
  for (i in seq_len(n)) {
    miss_cols <- which(!is.finite(mat[i, ]))
    if (length(miss_cols) == 0) next
    for (j in miss_cols) {
      candidates <- which(is.finite(mat[, j]) & seq_len(n) != i)
      if (length(candidates) == 0) next
      dist <- rep(Inf, length(candidates))
      for (k in seq_along(candidates)) {
        r <- candidates[[k]]
        overlap <- which(is.finite(mat[i, ]) & is.finite(mat[r, ]))
        if (length(overlap) == 0) next
        dist[[k]] <- mean(abs(mat[i, overlap] - mat[r, overlap]))
      }
      best <- candidates[[which.min(dist)]]
      if (is.finite(mat[best, j])) {
        mat[i, j] <- mat[best, j]
        imputed <- imputed + 1
      }
    }
  }
  list(mat = mat, imputed = imputed)
}

impute_svd_like <- function(mat, rank = 3) {
  rank <- max(1, as.numeric(rank))
  col_means <- apply(mat, 2, function(x) mean(x[is.finite(x)]))
  global_mean <- mean(as.numeric(mat[is.finite(mat)]))
  if (!is.finite(global_mean)) global_mean <- 0
  imputed <- 0
  for (i in seq_len(nrow(mat))) {
    row_vals <- mat[i, ]
    row_mean <- mean(row_vals[is.finite(row_vals)])
    if (!is.finite(row_mean)) row_mean <- global_mean
    miss <- which(!is.finite(row_vals))
    if (length(miss) == 0) next
    for (j in miss) {
      col_mean <- col_means[[j]]
      if (!is.finite(col_mean)) col_mean <- global_mean
      mat[i, j] <- (rank * col_mean + row_mean) / (rank + 1)
      imputed <- imputed + 1
    }
  }
  list(mat = mat, imputed = imputed)
}

impute_bpca_like <- function(mat, max_iter = 5) {
  max_iter <- max(1, min(as.integer(max_iter), 20))
  original_missing <- !is.finite(mat)
  init <- impute_column_stat(mat, median)
  mat <- init$mat

  for (iter in seq_len(max_iter)) {
    col_means <- apply(mat, 2, function(x) mean(x[is.finite(x)]))
    global_mean <- mean(as.numeric(mat[is.finite(mat)]))
    if (!is.finite(global_mean)) global_mean <- 0
    for (i in seq_len(nrow(mat))) {
      row_mean <- mean(mat[i, is.finite(mat[i, ])])
      if (!is.finite(row_mean)) row_mean <- global_mean
      miss <- which(original_missing[i, ])
      if (length(miss) == 0) next
      for (j in miss) {
        col_mean <- col_means[[j]]
        if (!is.finite(col_mean)) col_mean <- global_mean
        mat[i, j] <- 0.6 * col_mean + 0.4 * row_mean
      }
    }
  }

  list(mat = mat, imputed = sum(original_missing))
}

impute_hybrid <- function(mat) {
  original_missing <- !is.finite(mat)
  row_missing_ratio <- rowMeans(original_missing)
  mar <- impute_knn_like(mat)$mat
  mnar <- impute_left_shift(mat)$mat

  for (i in seq_len(nrow(mat))) {
    miss <- which(original_missing[i, ])
    if (length(miss) == 0) next
    use_mnar <- row_missing_ratio[[i]] >= 0.4
    if (use_mnar) {
      mat[i, miss] <- mnar[i, miss]
    } else {
      mat[i, miss] <- mar[i, miss]
    }
  }
  list(mat = mat, imputed = sum(original_missing))
}

apply_preprocessing_config <- function(d) {
  cfg <- d$preprocessing_config
  if (is.null(cfg)) {
    return(list(payload = d, summary = list(applied = FALSE)))
  }

  seed <- as.integer(value_or_default(cfg$seed, 42))
  if (!is.finite(seed)) seed <- 42
  set.seed(seed)

  mat <- build_expression_matrix(d)
  sample_names <- colnames(mat)
  genes <- rownames(mat)

  summary <- list(
    applied = TRUE,
    config_seed = seed,
    filtering = list(algorithm = value_or_default(cfg$filtering$algorithm, "rule-based"), removed_rows = 0),
    imputation = list(algorithm = value_or_default(cfg$imputation$algorithm, "none"), imputed_count = 0),
    normalization = list(algorithm = value_or_default(cfg$normalization$algorithm, "no-normalization")),
    batch_correction = list(algorithm = value_or_default(cfg$batch_correction$algorithm, "none"), corrected = FALSE)
  )

  if (!is.null(cfg$filtering) && identical(value_or_default(cfg$filtering$algorithm, "rule-based"), "rule-based")) {
    params <- value_or_default(cfg$filtering$params, list())
    if (isTRUE(value_or_default(params$low_variance_filter, FALSE))) {
      threshold <- as.numeric(value_or_default(params$variance_threshold, 0))
      keep <- apply(mat, 1, function(row) {
        finite <- row[is.finite(row)]
        if (length(finite) <= 1) return(FALSE)
        stats::var(finite) >= threshold
      })
      summary$filtering$removed_rows <- sum(!keep)
      mat <- mat[keep, , drop = FALSE]
      genes <- rownames(mat)
    }
  }

  imp <- value_or_default(cfg$imputation, list(algorithm = "none", params = list()))
  imp_alg <- as.character(value_or_default(imp$algorithm, "none"))
  imp_params <- value_or_default(imp$params, list())
  imp_result <- list(mat = mat, imputed = 0)

  if (imp_alg == "none") {
    imp_result <- list(mat = mat, imputed = 0)
  } else if (imp_alg == "min-half") {
    imp_result <- impute_min_half(mat)
  } else if (imp_alg == "left-shift-gaussian") {
    imp_result <- impute_left_shift(
      mat,
      downshift = as.numeric(value_or_default(imp_params$downshift, 1.8)),
      width = as.numeric(value_or_default(imp_params$width, 0.3))
    )
  } else if (imp_alg == "minprob") {
    imp_result <- impute_minprob(
      mat,
      q = as.numeric(value_or_default(imp_params$q, 0.01))
    )
  } else if (imp_alg == "QRILC") {
    imp_result <- impute_qrilc(
      mat,
      tune_sigma = as.numeric(value_or_default(imp_params$tune_sigma, 1))
    )
  } else if (imp_alg == "KNN") {
    imp_result <- impute_knn_like(mat)
  } else if (imp_alg == "SVD") {
    imp_result <- impute_svd_like(
      mat,
      rank = as.numeric(value_or_default(imp_params$rank, 3))
    )
  } else if (imp_alg == "BPCA") {
    imp_result <- impute_bpca_like(
      mat,
      max_iter = as.numeric(value_or_default(imp_params$max_iter, 5))
    )
  } else if (imp_alg == "missForest") {
    imp_result <- impute_column_stat(mat, median)
  } else if (imp_alg == "hybrid") {
    imp_result <- impute_hybrid(mat)
  } else {
    imp_result <- impute_min_half(mat)
  }
  mat <- imp_result$mat
  summary$imputation$algorithm <- imp_alg
  summary$imputation$imputed_count <- imp_result$imputed

  norm <- value_or_default(cfg$normalization, list(algorithm = "no-normalization", params = list()))
  norm_alg <- as.character(value_or_default(norm$algorithm, "no-normalization"))
  norm_params <- value_or_default(norm$params, list())
  if (norm_alg == "median") {
    col_med <- apply(mat, 2, function(x) stats::median(x[is.finite(x)]))
    global_med <- stats::median(col_med[is.finite(col_med)])
    for (j in seq_len(ncol(mat))) {
      if (!is.finite(col_med[[j]])) next
      idx <- which(is.finite(mat[, j]))
      mat[idx, j] <- mat[idx, j] - col_med[[j]] + global_med
    }
  } else if (norm_alg == "z-score") {
    by <- as.character(value_or_default(norm_params$by, "feature"))
    if (by == "sample") {
      for (j in seq_len(ncol(mat))) {
        idx <- which(is.finite(mat[, j]))
        if (length(idx) == 0) next
        mu <- mean(mat[idx, j])
        sdv <- stats::sd(mat[idx, j])
        if (!is.finite(sdv) || sdv < 1e-6) sdv <- 1e-6
        mat[idx, j] <- (mat[idx, j] - mu) / sdv
      }
    } else {
      for (i in seq_len(nrow(mat))) {
        idx <- which(is.finite(mat[i, ]))
        if (length(idx) == 0) next
        mu <- mean(mat[i, idx])
        sdv <- stats::sd(mat[i, idx])
        if (!is.finite(sdv) || sdv < 1e-6) sdv <- 1e-6
        mat[i, idx] <- (mat[i, idx] - mu) / sdv
      }
    }
  }
  summary$normalization$algorithm <- norm_alg

  bc <- value_or_default(cfg$batch_correction, list(algorithm = "none", params = list()))
  bc_alg <- as.character(value_or_default(bc$algorithm, "none"))
  bc_params <- value_or_default(bc$params, list())
  if (bc_alg != "none") {
    batch_field <- as.character(value_or_default(bc_params$group_field, "batch"))
    batches <- vapply(
      d$samples,
      function(s) {
        b <- s[[batch_field]]
        if (is.null(b) || length(b) == 0) return(NA_character_)
        as.character(b)
      },
      character(1)
    )
    uniq <- unique(batches[!is.na(batches) & nzchar(batches)])
    if (length(uniq) > 0) {
      for (i in seq_len(nrow(mat))) {
        global_mean <- mean(mat[i, is.finite(mat[i, ])])
        if (!is.finite(global_mean)) next
        for (b in uniq) {
          idx <- which(batches == b & is.finite(mat[i, ]))
          if (length(idx) == 0) next
          batch_mean <- mean(mat[i, idx])
          mat[i, idx] <- mat[i, idx] - batch_mean + global_mean
        }
      }
      summary$batch_correction$corrected <- TRUE
      summary$batch_correction$batch_field <- batch_field
      summary$batch_correction$batch_groups <- length(uniq)
    }
  }
  summary$batch_correction$algorithm <- bc_alg

  rownames(mat) <- genes
  colnames(mat) <- sample_names
  d2 <- matrix_to_payload(d, mat)
  d2$preprocessing <- summary
  list(payload = d2, summary = summary)
}

run_limma_de <- function(d) {
  if (!requireNamespace("limma", quietly = TRUE)) {
    stop("required package missing: limma")
  }

  mat <- build_expression_matrix(d)

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

  build_qc <- function(mat_input, sample_table) {
    pca_points <- list()
    explained <- list(pc1 = 0, pc2 = 0)

    pca_obj <- tryCatch({
      stats::prcomp(t(mat_input), center = TRUE, scale. = TRUE)
    }, error = function(e) NULL)

    if (!is.null(pca_obj) && !is.null(pca_obj$x) && nrow(pca_obj$x) > 0) {
      vars <- (pca_obj$sdev ^ 2)
      total_var <- sum(vars)
      if (is.finite(total_var) && total_var > 0) {
        explained$pc1 <- round((vars[[1]] / total_var) * 100, 6)
        if (length(vars) >= 2) {
          explained$pc2 <- round((vars[[2]] / total_var) * 100, 6)
        }
      }

      pca_frame <- data.frame(
        sample_id = rownames(pca_obj$x),
        pc1 = if ("PC1" %in% colnames(pca_obj$x)) as.numeric(pca_obj$x[, "PC1"]) else rep(0, nrow(pca_obj$x)),
        pc2 = if ("PC2" %in% colnames(pca_obj$x)) as.numeric(pca_obj$x[, "PC2"]) else rep(0, nrow(pca_obj$x)),
        stringsAsFactors = FALSE
      )

      pca_frame$group <- vapply(
        pca_frame$sample_id,
        function(sample_name) {
          hit <- sample_table$group[sample_table$sample == sample_name]
          if (length(hit) == 0) return("Unknown")
          as.character(hit[[1]])
        },
        character(1)
      )
      pca_frame$loading <- rep(1, nrow(pca_frame))
      pca_points <- rows_to_list(pca_frame[, c("sample_id", "group", "pc1", "pc2", "loading"), drop = FALSE])
    }

    cor_mat <- tryCatch({
      stats::cor(mat_input, use = "pairwise.complete.obs")
    }, error = function(e) matrix(0, nrow = ncol(mat_input), ncol = ncol(mat_input)))

    if (!is.matrix(cor_mat) || nrow(cor_mat) == 0) {
      cor_mat <- matrix(0, nrow = ncol(mat_input), ncol = ncol(mat_input))
      colnames(cor_mat) <- colnames(mat_input)
      rownames(cor_mat) <- colnames(mat_input)
    }

    cor_mat[is.na(cor_mat)] <- 0
    cor_mat <- round(cor_mat, 6)
    corr_rows <- lapply(seq_len(nrow(cor_mat)), function(i) as.numeric(cor_mat[i, ]))

    list(
      pca = list(
        explained_variance = explained,
        points = pca_points
      ),
      correlation = list(
        labels = as.list(colnames(cor_mat)),
        matrix = corr_rows
      )
    )
  }

  qc <- build_qc(mat, sample_df)

  list(
    de = list(
      summary = list(
        totalGenes = nrow(tt),
        significantGenes = nrow(sig),
        thresholds = list(log2fc = log2fc, padj = padj)
      ),
      topTable = rows_to_list(tt[seq_len(min(nrow(tt), 50)), , drop = FALSE])
    ),
    significantGenes = sig$gene,
    qc = qc
  )
}

run_clusterprofiler <- function(sig_genes, pvalue_cutoff = 0.05, qvalue_cutoff = 0.2) {
  if (!requireNamespace("clusterProfiler", quietly = TRUE)) {
    stop("required package missing: clusterProfiler")
  }
  if (!requireNamespace("org.Hs.eg.db", quietly = TRUE)) {
    stop("required package missing: org.Hs.eg.db")
  }

  if (length(sig_genes) == 0) {
    return(list(go = list(), kegg = list()))
  }

  mapped <- tryCatch({
    clusterProfiler::bitr(
      sig_genes,
      fromType = "SYMBOL",
      toType = "ENTREZID",
      OrgDb = org.Hs.eg.db::org.Hs.eg.db
    )
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

run_de_enrich_pipeline <- function(payload_root) {
  mode <- payload_root$mode
  payload <- payload_root$payload

  if (is.null(mode) || is.null(payload)) {
    stop("mode and payload are required")
  }

  prep <- apply_preprocessing_config(payload)
  payload <- prep$payload

  if (mode == "de") {
    de_result <- run_limma_de(payload)
    de_result$preprocessing <- prep$summary
    return(de_result)
  }

  if (mode == "enrichment" || mode == "de-enrich") {
    de_result <- run_limma_de(payload)
    enrich <- run_clusterprofiler(
      de_result$significantGenes,
      as.numeric(payload$enrichment$pvalueCutoff),
      as.numeric(payload$enrichment$qvalueCutoff)
    )
    return(list(
      de = de_result$de,
      significantGenes = de_result$significantGenes,
      enrichment = enrich,
      preprocessing = prep$summary
    ))
  }

  stop(paste0("unsupported mode: ", mode))
}
