-- 02_pos_cash.sql
-- Erweitert erlaubte Provider um 'cash'

-- alte Check-Constraint weg, neue mit 'cash' rein
DO $$
BEGIN
  ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_provider_check;
EXCEPTION WHEN undefined_object THEN
  -- nichts
END $$;

ALTER TABLE payments
  ADD CONSTRAINT payments_provider_check
  CHECK (provider IN ('cash','sumup','wallee','worldline','nexi','paytec'));
