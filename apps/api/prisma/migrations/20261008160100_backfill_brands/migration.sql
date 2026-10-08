-- Turn the free-text brand names already on products into Brand rows.
INSERT INTO "Brand" ("id", "name")
SELECT gen_random_uuid()::text, p.name
FROM (SELECT DISTINCT ON (lower(trim(brand))) trim(brand) AS name FROM "Product" WHERE brand IS NOT NULL AND trim(brand) <> '' ORDER BY lower(trim(brand)), trim(brand)) p
ON CONFLICT ("name") DO NOTHING;

UPDATE "Product" p
SET "brandId" = b.id, "brand" = b.name
FROM "Brand" b
WHERE p."brandId" IS NULL AND p.brand IS NOT NULL AND lower(trim(p.brand)) = lower(b.name);
