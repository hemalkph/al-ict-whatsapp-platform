import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, tz, updatedAt } from "./_shared";

export const organizations = pgTable("organizations", {
  id: pk(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique("organizations_slug_unique"),
  archivedAt: tz("archived_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Every tenant-owned table carries this column (ADR 0005/0011). */
export const orgId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id);
