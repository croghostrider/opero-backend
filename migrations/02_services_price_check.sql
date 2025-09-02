-- 02_services_price_check.sql
ALTER TABLE services
  ADD CONSTRAINT services_price_nonneg
  CHECK (price IS NULL OR price >= 0);
