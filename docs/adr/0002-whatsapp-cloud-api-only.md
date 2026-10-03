# ADR 0002: Meta Cloud API only

Status: Accepted

## Context

WhatsApp Web automation and unofficial clients risk account bans and violate platform terms.

## Decision

Use only the official Meta WhatsApp Business Platform Cloud API. No Puppeteer, Chromium, Selenium, whatsapp-web.js, Baileys, QR-linked devices or unofficial clients. All outbound messages pass through one messaging service and compliance guard; the frontend never calls Meta.
