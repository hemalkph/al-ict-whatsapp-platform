# ADR 0007: Deterministic rule-based bot, no arbitrary code

Status: Accepted

## Context

Admins will design bot flows; the bot is not AI.

## Decision

A node-based deterministic runtime. ACTION nodes call an allowlisted action registry; admins cannot supply executable JavaScript. Published versions are immutable; drafts never affect the live bot. Runtime first, Bot Studio UI later.
