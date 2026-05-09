-- Seed initial overrides for cottonhip and flybrief families.
-- These were the trigger for building Auto-naming Option B — 16 launch
-- rows on /launches were rendering raw SKU codes (ev-cottonhip-5x-l,
-- ev-flybrief-3x-l, etc.) because the families weren't in
-- FAMILY_LABELS. Seeding here means /launches resolves immediately on
-- next syncProductNames cron without Scott needing to enter them
-- manually post-deploy.
--
-- Names match Scott's freeform usage 2026-05-08; can be adjusted via
-- the /admin/product-names UI without a code deploy.
--
-- cottonhip: ships only in 5-packs → drop the "5-Pack" suffix
--   (matches IMPLICIT_5PACK_FAMILIES behavior for similar single-tier
--   families like bshort, sw, hip, bik, french)
-- flybrief: ships in 3-packs → 3-Pack is always retained anyway, so
--   is_implicit_5pack is irrelevant; set false to be explicit.
INSERT INTO sku_family_overrides (family, display_label, is_implicit_5pack, alias_of, updated_by)
VALUES
  ('cottonhip', 'Cotton Hipster', true, NULL, 'seed-migration-0009'),
  ('flybrief', 'Mens Brief with Fly', false, NULL, 'seed-migration-0009')
ON CONFLICT (family) DO NOTHING;
