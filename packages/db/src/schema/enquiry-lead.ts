import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * A business enquiry captured when a visitor asks about white labelling or a
 * bulk order. The conversation itself happens on WhatsApp; this row is the
 * record that someone asked, so an unanswered enquiry cannot go unnoticed just
 * because nobody saw the message.
 *
 * Formerly `subscription_lead` (renamed in 0069). That table never had a writer,
 * so the owner's inbox was always empty; this one is written by
 * POST /v1/public/enquiries.
 */
export const enquiryLead = pgTable(
  "enquiry_lead",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    /** 'white_label' | 'bulk_order' (or 'legacy_subscription' for pre-0069 rows). */
    enquiryType: text("enquiry_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxCreated: index("idx_enquiry_lead_created").on(t.createdAt),
  }),
);
