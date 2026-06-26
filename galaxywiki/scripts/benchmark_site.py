#!/usr/bin/env python3
# /// script
# dependencies = [
#   "playwright",
# ]
# ///
"""Benchmark Encyclopedia Galactica local page load and first detail open."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


URL = os.environ.get("EG_URL", "http://127.0.0.1:8000/")


def ms_since(start: float) -> int:
    return round((time.perf_counter() - start) * 1000)


def existing_chromium() -> str | None:
    cache = Path.home() / ".cache/ms-playwright"
    candidates = sorted(
        [
            *cache.glob("chromium-*/chrome-linux64/chrome"),
            *cache.glob("chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"),
        ],
        reverse=True,
    )
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def main() -> None:
    with sync_playwright() as p:
        executable_path = existing_chromium()
        launch_args = {"headless": True}
        if executable_path:
            launch_args["executable_path"] = executable_path
        browser = p.chromium.launch(**launch_args)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        t0 = time.perf_counter()
        page.goto(URL, wait_until="domcontentloaded", timeout=60_000)
        domcontentloaded_ms = ms_since(t0)
        page.wait_for_selector(".tile", timeout=60_000)
        first_tile_ms = ms_since(t0)
        page.wait_for_function(
            """
            () => {
              const img = document.querySelector('.tile img');
              return img && img.complete && img.naturalWidth > 0;
            }
            """,
            timeout=60_000,
        )
        first_tile_image_ms = ms_since(t0)
        home_stats = page.evaluate(
            """
            () => ({
              tileCount: document.querySelectorAll('.tile').length,
              imageCount: document.querySelectorAll('.tile img').length,
              bodyTextLength: document.body.innerText.length,
              resources: performance.getEntriesByType('resource').map((r) => ({
                name: r.name,
                duration: Math.round(r.duration),
                transferSize: r.transferSize || 0,
                decodedBodySize: r.decodedBodySize || 0,
              })),
            })
            """
        )

        t1 = time.perf_counter()
        page.click(".tile")
        page.wait_for_selector(".entry-shell", timeout=60_000)
        entry_shell_ms = ms_since(t1)
        page.wait_for_selector(".source", timeout=60_000)
        first_source_ms = ms_since(t1)
        page.wait_for_selector(".quote", timeout=60_000)
        first_quote_ms = ms_since(t1)
        entry_stats = page.evaluate(
            """
            () => ({
              title: document.querySelector('.title-block h1')?.textContent,
              sourceCount: document.querySelectorAll('.source').length,
              quoteCount: document.querySelectorAll('.quote').length,
              shardRequests: performance
                .getEntriesByType('resource')
                .filter((entry) => entry.name.includes('/data/shards/'))
                .length,
            })
            """
        )
        browser.close()

    print(
        json.dumps(
            {
                "url": URL,
                "domcontentloaded_ms": domcontentloaded_ms,
                "first_tile_ms": first_tile_ms,
                "first_tile_image_ms": first_tile_image_ms,
                "entry_shell_ms": entry_shell_ms,
                "first_source_ms": first_source_ms,
                "first_quote_ms": first_quote_ms,
                "home_stats": home_stats,
                "entry_stats": entry_stats,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
