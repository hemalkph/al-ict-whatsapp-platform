# Master Spec

Internal WhatsApp management platform for an A/L ICT education class. It uses **only** the official Meta WhatsApp Business Platform Cloud API. No WhatsApp Web automation, unofficial clients or QR-linked devices, ever. No AI/chatbot generation at this stage.

## Product scope (target)

Team members with roles; shared inbox; multiple WhatsApp numbers (later); contacts, leads, students; conversation assignment and open/pending/resolved states; internal notes, tags, quick replies; message templates; message statuses (sent/delivered/read/failed); Click-to-WhatsApp ad referral attribution; lead funnel; deterministic rule-based bot (buttons, lists, Flows, handover, versions, publish, rollback); campaigns with cost protections; opt-in/opt-out; audit logs; Meta account/number health; analytics later. Registrations, batches, payments and attendance come later.

## Flow

Ad → WhatsApp message → Meta webhook → create/update contact → save ad referral → create lead → start bot → language/menus → registration/payment/class info → optional WhatsApp Flow → human handover → conversion to student.

## Principles

- Modular monolith, one repository. See ARCHITECTURE.md.
- Organization isolation from day one (`organization_id`), but this is not a commercial multi-tenant SaaS: no subscriptions, billing, reseller or plan limits.
- All outbound messaging goes through one messaging service and a safety/compliance guard. The frontend never calls Meta.
- Policy rules live in configuration/domain logic, not scattered constants.
- Uncertain assumptions are documented, not silently invented.

## Current stage

Foundation only. See ROADMAP.md.
