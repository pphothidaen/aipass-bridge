"""Smart Router for aipass-bridge — tier-2 intent classification.

Routes prompts to the appropriate model tier:
  tier 0 = local (self-hosted)
  tier 1 = cloud (paid, e.g. Claude)
  tier 2 = nous_free (free tier, e.g. Gemini flash-lite)
"""

from __future__ import annotations

import re

# Simple greetings / acknowledgements that don't need a powerful model
_SIMPLE_KEYWORDS = {
    "สวัสดี", "hello", "hi", "ok", "ขอบคุณ",
    "hey", "yo", "sup", "bye", "goodbye",
    "thanks", "thank", "ครับ", "ค่ะ", "นะคะ",
    "5555", "555", "ฮัลโล", "ไง", "ดีจ้า",
}

# Patterns suggesting complex / multi-step work
_COMPLEX_PATTERNS = [
    r"\brefactor\b",
    r"\bimplement\b",
    r"\bcreate\b.*\b(feature|module|service|api|endpoint)\b",
    r"\bwrite\b.*\b(code|test|document|readme)\b",
    r"\bdebug\b",
    r"\bfix\b.*\b(bug|issue|error)\b",
    r"\bexplain\b.*\b(how|why|what)\b",
    r"\bcompare\b",
    r"\banalyze\b",
    r"\boptimize\b",
    r"\bdesign\b",
    r"\barchitect\b",
    r"\bmigrate\b",
    r"\breview\b",
    r"\bexplain\s+(this|the|a)\s+(code|function|class|file)\b",
    r"\bhow\s+does\b",
    r"\bwhat\s+(is|are)\b",
    r"\bwhy\s+(does|is|are)\b",
    r"\bgenerate\b",
    r"\bbuild\b",
    r"\bsetup\b",
    r"\bconfigure\b",
    r"\bdeploy\b",
]

# Indicators that the prompt is long-context (needs a capable model)
_LONG_CONTEXT_MIN_TOKENS = 50
_LONG_CONTEXT_MIN_WORDS = 30


def _estimate_cost(tier: int, token_count: int) -> float:
    """Estimate cost in USD per 1K tokens."""
    # Approximate pricing (subject to change)
    cost_map = {
        0: 0.0001,   # local — negligible, amortized infra
        1: 0.015,    # Claude Sonnet class paid
        2: 0.0,      # Gemini Flash-Lite free tier
    }
    return round(cost_map.get(tier, 0.0) * (token_count / 1000), 6)


def _rough_token_count(prompt: str) -> int:
    """Rough token estimate: ~1 token per 4 chars for Latin, ~1.5 chars for Thai."""
    # Simple heuristic: split on whitespace and punctuation
    words = re.findall(r"[\w']+", prompt)
    return max(len(words), len(prompt) // 3)


def _is_simple_query(prompt: str, tokens: int) -> bool:
    """Determine if the prompt is a short, trivial query."""
    stripped = prompt.strip().lower()
    if tokens < 50:
        # Check if the prompt is dominated by simple keywords
        words = set(re.findall(r"\b\w+\b", stripped))
        simple_words = words & _SIMPLE_KEYWORDS
        # If most words are simple keywords, route to free
        if len(words) <= 3 and simple_words:
            return True
        if len(words) <= 1 and tokens <= 2:
            return True
    return False


def _is_complex_query(prompt: str, tokens: int) -> bool:
    """Determine if the prompt is complex and needs a paid model."""
    stripped = prompt.strip().lower()

    # Long prompts likely need a more capable model
    if tokens >= _LONG_CONTEXT_MIN_TOKENS:
        return True

    word_count = len(re.findall(r"\b\w+\b", stripped))
    if word_count >= _LONG_CONTEXT_MIN_WORDS:
        return True

    # Pattern match for complex intent keywords
    for pattern in _COMPLEX_PATTERNS:
        if re.search(pattern, stripped):
            return True

    # Multi-line prompts often mean code or structured content
    if prompt.count("\n") >= 3:
        return True

    return False


def classify_intent(prompt: str) -> dict:
    """Classify the intent of a prompt and return routing info.

    Returns a dict with keys:
      tier          — 0=local, 1=cloud (paid), 2=nous_free (free tier)
      model         — model name to use
      reason        — human-readable reason for the decision
      estimated_cost — estimated cost in USD for this query
    """
    if not prompt or not prompt.strip():
        return {
            "tier": 0,
            "model": "local-default",
            "reason": "Empty prompt — routing to local.",
            "estimated_cost": 0.0,
        }

    tokens = _rough_token_count(prompt)

    # Tier 2: free — short simple queries
    if _is_simple_query(prompt, tokens):
        return {
            "tier": 2,
            "model": "gemini-3.1-flash-lite",
            "reason": (
                f"Short simple query (~{tokens} tokens). "
                "Matching simple keyword pattern — free tier suitable."
            ),
            "estimated_cost": _estimate_cost(2, tokens),
        }

    # Tier 1: paid — complex or long-context queries
    if _is_complex_query(prompt, tokens):
        return {
            "tier": 1,
            "model": "claude-sonnet-5",
            "reason": (
                f"Complex or long-context query (~{tokens} tokens). "
                "Requires a capable model for quality results."
            ),
            "estimated_cost": _estimate_cost(1, tokens),
        }

    # Default: local for short, non-trivial queries that aren't clearly complex
    return {
        "tier": 0,
        "model": "local-default",
        "reason": (
            f"Short, non-trivial query (~{tokens} tokens). "
            "Routing to local model."
        ),
        "estimated_cost": _estimate_cost(0, tokens),
    }


def should_track(prompt: str) -> bool:
    """Determine whether a prompt should be tracked for analytics.

    Returns True if the prompt is non-trivial and worth recording
    for usage analytics (skip empty, blank, or pure-greeting prompts).
    """
    if not prompt or not prompt.strip():
        return False

    stripped = prompt.strip().lower()
    tokens = _rough_token_count(prompt)

    # Don't track trivial greetings/acknowledgements
    if _is_simple_query(prompt, tokens):
        return False

    # Don't track single-word filler
    word_count = len(re.findall(r"\b\w+\b", stripped))
    if word_count <= 1 and tokens <= 2:
        return False

    return True
