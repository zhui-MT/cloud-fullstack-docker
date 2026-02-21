# BioID Proteomics Analyst (Docker)

BioID 蛋白组数据分析平台，目标是对标并达到 **FragPipe-Analyst** 的核心水准，支持在线交互分析、可复现计算与高质量图形下载。

## 1. Project Goal

本项目用于蛋白组结果表（非原始 RAW/mzML）的一站式分析，支持：

- 多来源输入：`FragPipe` / `DIA-NN` / `MaxQuant`
- 多实验类型：`DIA` / `DDA` / `TMT`
- 在线清洗、归一化、差异分析与富集分析
- 交互式可视化：`PCA`、`Correlation Heatmap`、`Volcano`、`GO/KEGG`
- 所有图与结果表可下载（PNG/SVG/CSV）

对标站点：https://fragpipe-analyst.nesvilab.org/

## 2. V1 Scope

### In Scope
- Protein + Peptide 双层分析
- 参数化数据清洗与预处理（可追溯）
- 多差异算法可切换
- GO/KEGG 本地计算（clusterProfiler）
- 单租户 Docker 私有部署

### Out of Scope (V1)
- 原始质谱文件搜库流程
- 自动 PDF/HTML 报告生成
- 多租户 SaaS 账户体系

## 3. Data Input

支持上传三类工具导出的结果表：

- FragPipe: protein/peptide level tables
- DIA-NN: protein/precursor(peptide-aggregated) tables
- MaxQuant: `proteinGroups` / `peptides`

统一内部主键：`UniProt Accession`（优先）

## 4. Data Cleaning & Preprocessing

### 4.1 Filtering
- contaminant filter
- reverse/decoy filter
- low coverage filter
- low variance filter (optional)
- minimum peptide count filter (protein-level optional)

### 4.2 Missing Value Imputation
- `none`
- `min-half`
- `left-shift-gaussian`
- `minprob`
- `QRILC`
- `KNN`
- `SVD`
- `BPCA`
- `missForest` (expert mode)
- `hybrid` (MAR/MNAR split, expert mode)

### 4.3 Normalization
- `no-normalization`
- `median`
- `quantile`
- `VSN`
- `cyclic-loess`
- `TIC`
- `z-score`
- `RLR` (optional)

### 4.4 Batch Correction
- `none`
- `ComBat`
- `ComBat-seq`
- `limma removeBatchEffect`
- `RUVg/RUVs` (expert mode)

所有参数实时回显，并写入会话配置（`config_rev` + `config_hash`）以保证可复现。

## 5. Differential Expression

可选 DE 引擎：

- `limma`
- `DEqMS`
- `MSstats`
- `SAM`
- `RankProd`

FDR correction:
- `BH` (default)
- `BY`
- `Bonferroni`
- `qvalue`

## 6. Visualization & Download

- PCA
- Correlation heatmap
- Volcano plot
- Expression heatmap
- GO/KEGG enrichment plot
- Single protein/peptide expression view

下载格式：
- 图：`PNG` / `SVG`
- 表：`CSV`

## 7. Architecture

当前 Compose 已扩展为六服务：

- `frontend` (React + Vite)
- `api` (Node.js + Express)
- `r-engine` (R + plumber)
- `redis` (queue/cache)
- `postgres` (metadata)
- `minio` (artifacts)

## 8. Quick Start

1. 准备环境变量

```bash
cd /Users/zhui/Desktop/cs/cloud-fullstack-docker
cp .env.example .env
```

2. 启动服务

```bash
docker compose up -d --build
```

3. 验证健康状态

```bash
docker compose ps
docker compose logs -f api
```

4. 访问入口

- Frontend: `http://localhost:5173`
- API health: `http://localhost:4000/api/health`
- R engine health: `http://localhost:8000/health`
- MinIO console: `http://localhost:9001`

## 9. Milestones

1. 输入解析与统一 schema（Protein + Peptide）
2. QC + Filtering + Imputation + Normalization
3. DE engines + contrast workflow
4. GO/KEGG + 图形下载
5. 对标回归测试 + 性能压测 + 发布

## 10. Acceptance Criteria

- 三类输入均可成功解析并进入分析流程
- 同一配置下重复运行结果一致（固定随机种子）
- 关键图表可在目标规模数据下满足交互时延
- 所有结果可追溯到参数版本（config revision）

## 11. References

- FragPipe-Analyst: https://fragpipe-analyst.nesvilab.org/
- FragPipe: https://www.nature.com/articles/s41587-023-01754-z
- DIA-NN: https://www.nature.com/articles/s41592-019-0638-x
- MaxQuant: https://www.mcponline.org/article/S1535-9476(20)31402-5/fulltext
- limma: https://academic.oup.com/nar/article/43/7/e47/2414268
- clusterProfiler: https://academic.oup.com/omicsonline/article/16/5/284/2605412
