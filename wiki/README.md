# Encyclopedia Galactica

Static GitHub Pages site for the galaxy-mentions wiki.

The site ships JSON data and bundled WebP galaxy cutouts, so a fresh clone is
enough to browse the atlas without live image generation.

## Local Preview

From this repository root:

```bash
uv run python -m http.server 8000 --directory .
```

Then open <http://localhost:8000/>.

The site is fully static. The bundled JSON data and `assets/images/*.webp`
cutouts are enough to browse the atlas. Dossier pages still include external
catalog/Legacy Survey viewer links for inspection.

## Benchmark

```bash
EG_URL=http://127.0.0.1:8000/ uv run scripts/benchmark_site.py
```

## Rebuild Data

From the parent `galaxywiki` workspace, if those source artifacts are present:

```bash
uv run encyclopediagalactica/scripts/build_site_data.py
```

The builder expects these local artifacts:

- `hf_repos/galaxy-mentions-wiki/data/wiki_entities/train-00000-of-00001.parquet`
- `hf/data/galaxy_mentions/train-00000-of-00001.parquet`
- `hf/data/evidence_quotes/train-00000-of-00001.parquet`
- `data/galaxy_mentions_wiki_images/image_manifest.parquet`
