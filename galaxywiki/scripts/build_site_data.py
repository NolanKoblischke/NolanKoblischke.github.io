#!/usr/bin/env python3
# /// script
# dependencies = [
#   "pandas",
#   "pyarrow",
# ]
# ///
"""Build static Encyclopedia Galactica data files from local wiki artifacts."""

from __future__ import annotations

import json
import math
import re
import shutil
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import pandas as pd


SITE_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = Path(__file__).resolve().parents[2]

ENTITIES_PATH = (
    SOURCE_ROOT
    / "hf_repos/galaxy-mentions-wiki/data/wiki_entities/train-00000-of-00001.parquet"
)
ENTITY_SUMMARIES_PATH = (
    SOURCE_ROOT
    / "hf_repos/galaxy-mentions-wiki/data/entity_summaries/train-00000-of-00001.parquet"
)
MENTIONS_PATH = SOURCE_ROOT / "hf/data/galaxy_mentions/train-00000-of-00001.parquet"
EVIDENCE_QUOTES_PATH = (
    SOURCE_ROOT / "hf/data/evidence_quotes/train-00000-of-00001.parquet"
)
IMAGE_MANIFEST_PATH = (
    SOURCE_ROOT / "data/galaxy_mentions_wiki_images/image_manifest.parquet"
)

DATA_DIR = SITE_ROOT / "data"
SHARDS_DIR = DATA_DIR / "shards"
IMAGE_ASSET_DIR = SITE_ROOT / "assets" / "images"
IMAGE_ASSET_PREFIX = "assets/images"
TARGET_MENTIONS_PER_SHARD = 650
INITIAL_INDEX_ROWS = 144
HIPS_ORDER = (
    "CDS/P/DESI-Legacy-Surveys/DR10/color",
    "CDS/P/PanSTARRS/DR1/color-i-r-g",
    "CDS/P/DSS2/color",
)
FEATURE_FLAG_ORDER = (
    "shells",
    "tidal",
    "streams",
    "mergers",
    "halos",
    "dwarfs",
    "hi",
    "agn",
)
INDEX_FIELDS = (
    "entity_id",
    "slug",
    "name",
    "ra_deg",
    "dec_deg",
    "ang_major_arcmin",
    "ang_minor_arcmin",
    "mention_count",
    "paper_count_total",
    "paper_count_eligible",
    "src_count",
    "top_topic",
    "topic_keys",
    "feature_mask",
    "hips_index",
    "fov_deg",
    "shard",
)

RX = {
    "shells": re.compile(
        r"\b(stellar shell|shell galax|shell system|shell structur|shells? and "
        r"(ripples|streams|tidal|stream)|concentric (shell|arc)|nested shell|"
        r"shells? in the (halo|outer|outskirts))",
        re.I,
    ),
    "tidal": re.compile(
        r"\b(tidal (tail|stream|debris|feature|arc|loop|bridge|distort|disrupt)|"
        r"tidal interaction|tidally (disturbed|disrupted|stripped))",
        re.I,
    ),
    "streams": re.compile(
        r"\b(stellar stream|tidal stream|stream of stars|debris stream)",
        re.I,
    ),
    "mergers": re.compile(
        r"\b((major|minor|recent|past|ongoing|ancient) merger|merger remnant|"
        r"post[- ]merger|coalesc|galactic immigration|collision course)",
        re.I,
    ),
}


def clean(value: Any) -> Any:
    """Return JSON-safe values without pandas/numpy sentinels."""
    if isinstance(value, list | tuple):
        output = []
        for item in value:
            cleaned = clean(item)
            if cleaned is not None:
                output.append(cleaned)
        return output
    if hasattr(value, "tolist") and not isinstance(value, str):
        return clean(value.tolist())
    if hasattr(value, "item") and not isinstance(value, str):
        try:
            return clean(value.item())
        except ValueError:
            pass
    if isinstance(value, dict):
        return {
            str(key): cleaned
            for key, item in value.items()
            if (cleaned := clean(item)) is not None
        }
    if isinstance(value, float):
        return None if math.isnan(value) else value
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return value


def compact_float(value: Any, digits: int = 7) -> float | None:
    cleaned = clean(value)
    if cleaned is None:
        return None
    return round(float(cleaned), digits)


def unique_in_order(values: list[Any]) -> list[Any]:
    seen: set[str] = set()
    output: list[Any] = []
    for value in values:
        cleaned = clean(value)
        if cleaned is None or cleaned == "":
            continue
        key = json.dumps(cleaned, sort_keys=True, ensure_ascii=False)
        if key in seen:
            continue
        seen.add(key)
        output.append(cleaned)
    return output


def row_value(row: pd.Series, key: str) -> Any:
    return clean(row[key]) if key in row else None


def clean_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        key: cleaned
        for key, value in record.items()
        if (cleaned := clean(value)) is not None
    }


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def slugify(text: str, used: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", text.casefold()).strip("-")
    if not base:
        base = "galaxy"
    slug = base
    index = 2
    while slug in used:
        slug = f"{base}-{index}"
        index += 1
    used.add(slug)
    return slug


def image_asset_path(entity_id: str) -> str:
    return f"{IMAGE_ASSET_PREFIX}/{entity_id}.webp"


def mention_record(row: pd.Series) -> dict[str, Any]:
    aliases = row_value(row, "aliases_in_paper") or []
    uat_terms = row_value(row, "uat_terms") or []
    source = clean_record(
        {
            "shard": row_value(row, "shard"),
            "source_member": row_value(row, "source_member"),
            "batch_id": row_value(row, "batch_id"),
            "batch_uid": row_value(row, "batch_uid"),
            "run_id": row_value(row, "run_id"),
        }
    )
    record = clean_record(
        {
            "mention_id": row_value(row, "mention_id"),
            "paper_id": row_value(row, "paper_id"),
            "arxiv_id": row_value(row, "arxiv_id"),
            "arxiv_url": row_value(row, "arxiv_url"),
            "raw_name": row_value(row, "raw_name"),
            "aliases_in_paper": aliases,
            "summary": row_value(row, "summary"),
            "total_evidence_sentence_count": row_value(
                row, "total_evidence_sentence_count"
            ),
            "discussion_extent": row_value(row, "discussion_extent"),
            "uat_terms": uat_terms,
            "paper_ra": compact_float(row_value(row, "paper_ra"), 8),
            "paper_dec": compact_float(row_value(row, "paper_dec"), 8),
            "paper_coordinate_text": row_value(row, "paper_coordinate_text"),
            "has_paper_coordinates": row_value(row, "has_paper_coordinates"),
            "evidence_quote_count": row_value(row, "evidence_quote_count"),
            "gemini_decision": row_value(row, "gemini_decision"),
            "source": source,
        }
    )
    return record


def quote_record(row: pd.Series) -> dict[str, Any]:
    return clean_record(
        {
            "quote_id": row_value(row, "quote_id"),
            "quote_index": row_value(row, "quote_index"),
            "quote": row_value(row, "quote"),
            "evidence_sentence_count": row_value(row, "evidence_sentence_count"),
        }
    )


def source_record(row: pd.Series, quote_rows: list[dict[str, Any]]) -> dict[str, Any]:
    return clean_record(
        {
            "mention_id": row_value(row, "mention_id"),
            "paper_id": row_value(row, "paper_id") or row_value(row, "arxiv_id"),
            "arxiv_id": row_value(row, "arxiv_id"),
            "arxiv_url": row_value(row, "arxiv_url"),
            "original_name": row_value(row, "raw_name"),
            "aliases_in_paper": row_value(row, "aliases_in_paper") or [],
            "sentence_count": row_value(row, "total_evidence_sentence_count"),
            "summary": row_value(row, "summary"),
            "discussion_extent": row_value(row, "discussion_extent"),
            "uat_terms": row_value(row, "uat_terms") or [],
            "paper_coordinate_text": row_value(row, "paper_coordinate_text"),
            "evidence_quote_count": row_value(row, "evidence_quote_count"),
            "quotes": quote_rows,
            "gemini_decision": row_value(row, "gemini_decision"),
        }
    )


def entity_image(row: pd.Series) -> dict[str, Any]:
    entity_id = str(row_value(row, "entity_id"))
    return clean_record(
        {
            "url": image_asset_path(entity_id),
            "hips": row_value(row, "hips"),
            "width": row_value(row, "width"),
            "height": row_value(row, "height"),
            "fov_deg": compact_float(row_value(row, "fov_deg"), 8),
            "fov_source": row_value(row, "fov_source"),
            "major_axis_arcmin": compact_float(
                row_value(row, "major_axis_arcmin"), 6
            ),
            "minor_axis_arcmin": compact_float(
                row_value(row, "minor_axis_arcmin"), 6
            ),
        }
    )


def topic_counts(mention_rows: pd.DataFrame) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    counts: Counter[str] = Counter()
    for terms in mention_rows["uat_terms"].tolist():
        for term in clean(terms) or []:
            if term:
                counts[str(term)] += 1
    rows = [
        {"term": term, "count": count}
        for term, count in sorted(counts.items(), key=lambda item: (-item[1], item[0].casefold()))
    ]
    return rows, rows


def compact_text(text: Any, max_chars: int | None = None) -> str:
    value = re.sub(r"\s+", " ", str(clean(text) or "")).strip()
    value = re.sub(r"\s+([,.;:])", r"\1", value)
    value = value.replace("M_.", "M_sun.").replace("M_ .", "M_sun.").replace("M_ ", "M_sun ")
    if not value or max_chars is None or len(value) <= max_chars:
        return value
    trimmed = value[: max_chars + 1].rsplit(" ", 1)[0].rstrip(" ,;:")
    return f"{trimmed}..."


def normalized_label(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()


def display_topics(name: str, topic_rows: list[dict[str, Any]], limit: int = 3) -> list[str]:
    name_key = normalized_label(name)
    output = []
    for row in topic_rows:
        term = str(row.get("term") or "")
        term_key = normalized_label(term)
        if not term or term_key == name_key:
            continue
        output.append(term)
        if len(output) >= limit:
            break
    return output


def entity_overview(
    name: str,
    mention_rows: pd.DataFrame,
    topic_rows: list[dict[str, Any]],
) -> str | None:
    paper_count = len(unique_in_order(mention_rows["paper_id"].tolist()))
    topics = display_topics(name, topic_rows, limit=3)
    summaries = [
        compact_text(summary, 220)
        for summary in mention_rows.sort_values(
            ["total_evidence_sentence_count", "paper_id", "mention_id"],
            ascending=[False, True, True],
            kind="stable",
        )["summary"].tolist()
    ]
    summaries = unique_in_order([summary for summary in summaries if summary])
    if not topics and not summaries:
        return None

    sentences = []
    if topics:
        topic_text = ", ".join(topics[:-1])
        if len(topics) > 1:
            topic_text = f"{topic_text}, and {topics[-1]}"
        else:
            topic_text = topics[0]
        sentences.append(
            f"Across {paper_count:,} paper{'s' if paper_count != 1 else ''}, {name} is discussed most often through {topic_text}."
        )
    else:
        sentences.append(
            f"Across {paper_count:,} paper{'s' if paper_count != 1 else ''}, {name} is preserved as a resolved literature entity in this corpus."
        )

    if summaries:
        sentences.append(f"A representative mention: {summaries[0]}")
    if len(summaries) > 1:
        sentences.append(f"Another recurring thread: {summaries[1]}")
    return " ".join(sentence.rstrip(".") + "." for sentence in sentences[:3])


def text_feature_counts(mention_rows: pd.DataFrame) -> dict[str, int]:
    texts = " ".join(
        str(text)
        for text in mention_rows["summary"].dropna().tolist()
        + mention_rows["paper_coordinate_text"].dropna().tolist()
    )
    return {key: len(pattern.findall(texts)) for key, pattern in RX.items()}


def uat_has(topic_rows: list[dict[str, Any]], needles: list[str]) -> bool:
    terms = [row["term"].casefold() for row in topic_rows]
    return any(needle in term for needle in needles for term in terms)


def feature_flags(mention_rows: pd.DataFrame, topic_rows: list[dict[str, Any]]) -> dict[str, bool]:
    counts = text_feature_counts(mention_rows)
    return {
        "shells": counts["shells"] >= 1,
        "tidal": counts["tidal"] >= 1,
        "streams": counts["streams"] >= 1 or uat_has(topic_rows, ["stellar streams"]),
        "mergers": counts["mergers"] >= 1,
        "halos": uat_has(topic_rows, ["galaxy stellar halos", "milky way stellar halo"]),
        "dwarfs": uat_has(
            topic_rows,
            [
                "dwarf galaxies",
                "dwarf spheroidal galaxies",
                "dwarf irregular galaxies",
                "dwarf elliptical galaxies",
            ],
        ),
        "hi": uat_has(topic_rows, ["hi shells", "h i shells"]),
        "agn": uat_has(topic_rows, ["active galactic nuclei", "supermassive black holes"]),
    }


def compact_index_payload(meta: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    hips_values = unique_in_order([row.get("hips") for row in rows])
    hips_index = {value: index for index, value in enumerate(hips_values)}
    compact_rows = []
    for row in rows:
        flags = row.get("feature_flags", {})
        mask = sum(
            1 << index
            for index, key in enumerate(FEATURE_FLAG_ORDER)
            if flags.get(key)
        )
        compact_rows.append(
            [
                row.get("entity_id"),
                row.get("slug"),
                row.get("name"),
                row.get("ra_deg"),
                row.get("dec_deg"),
                row.get("ang_major_arcmin"),
                row.get("ang_minor_arcmin"),
                row.get("mention_count"),
                row.get("paper_count_total"),
                row.get("paper_count_eligible"),
                row.get("src_count"),
                row.get("top_topic"),
                row.get("topic_keys"),
                mask,
                hips_index.get(row.get("hips")),
                row.get("fov_deg"),
                row.get("shard"),
            ]
        )
    return {
        "meta": meta,
        "fields": list(INDEX_FIELDS),
        "feature_flags": list(FEATURE_FLAG_ORDER),
        "hips_values": hips_values,
        "entities": compact_rows,
    }


def legacy_viewer_url(entity: pd.Series, image: pd.Series) -> str | None:
    ra = compact_float(row_value(entity, "ra_deg"), 8)
    dec = compact_float(row_value(entity, "dec_deg"), 8)
    if ra is None or dec is None:
        return None
    fov = float(row_value(image, "fov_deg") or 0.05)
    zoom = max(2, min(16, round(9 - math.log(max(fov, 0.001), 2))))
    params = urlencode({"ra": ra, "dec": dec, "zoom": zoom, "layer": "ls-dr10"})
    return f"https://www.legacysurvey.org/viewer?{params}"


def summarize_entity(
    entity: pd.Series,
    image: pd.Series,
    mention_rows: pd.DataFrame,
    shard_name: str,
    slug: str,
) -> dict[str, Any]:
    paper_ids = unique_in_order(mention_rows["paper_id"].tolist())
    uat_eligible, uat_all = topic_counts(mention_rows)
    image_info = entity_image(image)
    top_terms = [row["term"] for row in uat_eligible[:8]]

    return clean_record(
        {
            "entity_id": row_value(entity, "entity_id"),
            "slug": slug,
            "name": row_value(entity, "chosen_name"),
            "ra_deg": compact_float(row_value(entity, "ra_deg"), 8),
            "dec_deg": compact_float(row_value(entity, "dec_deg"), 8),
            "ang_major_arcmin": compact_float(row_value(image, "major_axis_arcmin"), 6),
            "ang_minor_arcmin": compact_float(row_value(image, "minor_axis_arcmin"), 6),
            "mention_count": len(mention_rows),
            "paper_count_total": len(paper_ids),
            "paper_count_eligible": len(paper_ids),
            "src_count": len(mention_rows),
            "top_topic": uat_eligible[0]["term"] if uat_eligible else None,
            "topic_keys": top_terms,
            "feature_flags": feature_flags(mention_rows, uat_eligible),
            "hips": image_info.get("hips"),
            "fov_deg": image_info.get("fov_deg"),
            "shard": shard_name,
        }
    )


def full_entity(
    entity: pd.Series,
    image: pd.Series,
    mention_rows: pd.DataFrame,
    summary: dict[str, Any],
    quote_rows_by_mention: dict[str, list[dict[str, Any]]],
    generated_overview: str | None,
) -> dict[str, Any]:
    sorted_mentions = mention_rows.sort_values(
        ["total_evidence_sentence_count", "paper_id", "mention_id"],
        ascending=[False, True, True],
        kind="stable",
    )
    sources = [
        source_record(
            row,
            quote_rows_by_mention.get(str(row_value(row, "mention_id")), []),
        )
        for _, row in sorted_mentions.iterrows()
    ]
    payload = dict(summary)
    payload["aliases_local"] = unique_in_order(mention_rows["raw_name"].tolist())
    payload["aliases_external"] = row_value(entity, "resolved_names") or []
    payload["uat_eligible"], payload["uat_all"] = topic_counts(mention_rows)
    payload["overview"] = generated_overview or entity_overview(
        str(row_value(entity, "chosen_name") or summary.get("name") or "This galaxy"),
        mention_rows,
        payload["uat_eligible"],
    )
    payload["image"] = entity_image(image)
    payload["image_path"] = image_asset_path(str(row_value(entity, "entity_id")))
    payload["viewer_url"] = legacy_viewer_url(entity, image)
    payload["coord_resolver"] = "galaxy-mentions 1 arcsec entity"
    payload["mention_ids"] = row_value(entity, "mention_ids") or []
    payload["sources"] = sources
    return payload


def search_text_for_entity(
    entity: pd.Series,
    mention_rows: pd.DataFrame,
    quote_rows_by_mention: dict[str, list[dict[str, Any]]],
    generated_overview: str | None = None,
) -> str:
    identity_pieces: list[Any] = [
        row_value(entity, "chosen_name"),
        *(row_value(entity, "resolved_names") or []),
        *mention_rows["raw_name"].tolist(),
    ]
    content_pieces: list[Any] = [
        generated_overview,
        *mention_rows["summary"].dropna().tolist(),
        *mention_rows["paper_coordinate_text"].dropna().tolist(),
    ]
    for terms in mention_rows["uat_terms"].tolist():
        identity_pieces.extend(clean(terms) or [])
    for mention_id in mention_rows["mention_id"].tolist():
        for quote in quote_rows_by_mention.get(str(mention_id), []):
            content_pieces.append(quote.get("quote"))

    exact_text = compact_text(
        " ".join(str(piece) for piece in unique_in_order(identity_pieces) if piece),
        None,
    ).casefold()
    tokens: set[str] = set()
    for piece in [*identity_pieces, *content_pieces]:
        for token in re.findall(r"[a-z0-9][a-z0-9.+-]*", str(piece or "").casefold()):
            if len(token) > 1 or token.isdigit():
                tokens.add(token)
    return f"{exact_text} {' '.join(sorted(tokens))}".strip()


def build() -> None:
    entities = pd.read_parquet(ENTITIES_PATH)
    entity_summaries = pd.read_parquet(ENTITY_SUMMARIES_PATH)
    mentions = pd.read_parquet(MENTIONS_PATH)
    evidence_quotes = pd.read_parquet(EVIDENCE_QUOTES_PATH)
    image_manifest = pd.read_parquet(IMAGE_MANIFEST_PATH)

    image_by_entity = image_manifest.set_index("entity_id", drop=False)
    summary_by_entity = {
        str(row["entity_id"]): compact_text(row["summary"])
        for _, row in entity_summaries.iterrows()
        if compact_text(row["summary"])
    }
    missing_summaries = set(entities["entity_id"].astype(str)) - set(summary_by_entity)
    if missing_summaries:
        raise RuntimeError(
            f"Missing generated entity summaries for {len(missing_summaries)} entities"
        )

    mention_ids = entities[["entity_id", "mention_ids"]].explode("mention_ids")
    mention_ids = mention_ids.rename(columns={"mention_ids": "mention_id"})
    resolved_mentions = mention_ids.merge(mentions, on="mention_id", how="left")
    if resolved_mentions["raw_name"].isna().any():
        missing = resolved_mentions[resolved_mentions["raw_name"].isna()]
        raise RuntimeError(f"Missing mention rows for {len(missing)} resolved mentions")

    by_entity = {
        entity_id: group.copy()
        for entity_id, group in resolved_mentions.groupby("entity_id", sort=False)
    }
    quote_rows_by_mention: dict[str, list[dict[str, Any]]] = {}
    for mention_id, quote_group in evidence_quotes.sort_values(
        ["mention_id", "quote_index"], kind="stable"
    ).groupby("mention_id", sort=False):
        quote_rows_by_mention[str(mention_id)] = [
            quote_record(row) for _, row in quote_group.iterrows()
        ]
    used_slugs: set[str] = set()
    slugs = {
        str(row["entity_id"]): slugify(str(row["chosen_name"]), used_slugs)
        for _, row in entities.iterrows()
    }

    if DATA_DIR.exists():
        shutil.rmtree(DATA_DIR)
    SHARDS_DIR.mkdir(parents=True, exist_ok=True)

    index_rows: list[dict[str, Any]] = []
    search_rows: list[dict[str, str]] = []
    shard_payload: dict[str, dict[str, Any]] = {}
    shard_counter = -1
    shard_mention_count = 0
    survey_counter: Counter[str] = Counter()
    dimension_counter: Counter[str] = Counter()

    def flush_shard() -> None:
        if not shard_payload:
            return
        shard_name = f"entities-{shard_counter:03d}.json"
        write_json(
            SHARDS_DIR / shard_name,
            {
                "shard": shard_name,
                "entity_count": len(shard_payload),
                "mention_count": sum(
                    len(entity["sources"]) for entity in shard_payload.values()
                ),
                "entities": shard_payload,
            },
        )

    for position, (_, entity) in enumerate(entities.iterrows()):
        entity_id = str(entity["entity_id"])
        mentions_for_entity = by_entity[entity_id]
        mention_count = len(mentions_for_entity)

        if (
            shard_payload
            and shard_mention_count + mention_count > TARGET_MENTIONS_PER_SHARD
        ):
            flush_shard()
            shard_payload = {}
            shard_mention_count = 0

        if not shard_payload:
            shard_counter += 1

        shard_name = f"entities-{shard_counter:03d}.json"
        image = image_by_entity.loc[entity_id]
        generated_overview = summary_by_entity.get(entity_id)

        summary = summarize_entity(
            entity,
            image,
            mentions_for_entity,
            shard_name,
            slugs[entity_id],
        )
        index_rows.append(summary)
        search_rows.append(
            {
                "slug": slugs[entity_id],
                "q": search_text_for_entity(
                    entity,
                    mentions_for_entity,
                    quote_rows_by_mention,
                    generated_overview,
                ),
            }
        )
        shard_payload[entity_id] = full_entity(
            entity,
            image,
            mentions_for_entity,
            summary,
            quote_rows_by_mention,
            generated_overview,
        )
        shard_mention_count += mention_count
        survey_counter[summary.get("hips", "unknown")] += 1
        dimension_counter[row_value(image, "fov_source") or "unknown"] += 1

    flush_shard()
    index_rows.sort(
        key=lambda row: (
            -((row.get("paper_count_total") or 0) + (2 if row.get("ra_deg") is not None and row.get("dec_deg") is not None else 0)),
            str(row.get("name") or "").casefold(),
        )
    )
    filter_counts = {
        "all": len(index_rows),
        "shells": sum(1 for row in index_rows if row.get("feature_flags", {}).get("shells")),
        "tidal": sum(1 for row in index_rows if row.get("feature_flags", {}).get("tidal")),
        "streams": sum(1 for row in index_rows if row.get("feature_flags", {}).get("streams")),
        "mergers": sum(1 for row in index_rows if row.get("feature_flags", {}).get("mergers")),
        "halos": sum(1 for row in index_rows if row.get("feature_flags", {}).get("halos")),
        "dwarfs": sum(1 for row in index_rows if row.get("feature_flags", {}).get("dwarfs")),
        "hi": sum(1 for row in index_rows if row.get("feature_flags", {}).get("hi")),
        "agn": sum(1 for row in index_rows if row.get("feature_flags", {}).get("agn")),
    }

    meta = {
        "title": "Encyclopedia Galactica",
        "subtitle": "Atlas of Galaxy Mentions",
        "generated_at": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "entity_count": len(entities),
        "resolved_mention_count": len(resolved_mentions),
        "source_mention_count": len(mentions),
        "target_mentions_per_shard": TARGET_MENTIONS_PER_SHARD,
        "shard_count": shard_counter + 1,
        "image_mode": "local_webp_q70",
        "survey_counts": dict(survey_counter),
        "fov_source_counts": dict(dimension_counter),
        "filter_counts": filter_counts,
        "sources": {
            "entities": str(ENTITIES_PATH.relative_to(SOURCE_ROOT)),
            "mentions": str(MENTIONS_PATH.relative_to(SOURCE_ROOT)),
            "evidence_quotes": str(EVIDENCE_QUOTES_PATH.relative_to(SOURCE_ROOT)),
            "images": str(IMAGE_MANIFEST_PATH.relative_to(SOURCE_ROOT)),
            "entity_summaries": str(ENTITY_SUMMARIES_PATH.relative_to(SOURCE_ROOT)),
        },
    }
    write_json(DATA_DIR / "entities.json", compact_index_payload(meta, index_rows))
    write_json(
        DATA_DIR / "initial.json",
        compact_index_payload(meta, index_rows[:INITIAL_INDEX_ROWS]),
    )
    write_json(DATA_DIR / "search.json", {"search": search_rows})
    write_json(DATA_DIR / "meta.json", meta)

    print(f"Wrote {len(index_rows):,} entities")
    print(f"Wrote {shard_counter + 1:,} shards")
    print(f"Wrote {len(resolved_mentions):,} resolved mentions")
    print(f"Loaded {len(summary_by_entity):,} generated entity summaries")


if __name__ == "__main__":
    build()
