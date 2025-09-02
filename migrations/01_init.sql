-- 01_init.sql
-- Fresh multi-tenant schema:
-- - Tenants with business types
-- - Products (food/goods) + ingredients & allergens
-- - Menus, QR tables, self-ordering
-- - Payments
-- - Employees, services, availability, time-off, bookings
-- Uses ONLY pgcrypto/gen_random_uuid(); no uuid-ossp; no subquery CHECKs.

---------------------------
-- Extensions
---------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

---------------------------
-- Reference: Business Types
---------------------------
CREATE TABLE business_types (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL UNIQUE,
  label      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seeds
INSERT INTO business_types (key, label) VALUES
  ('food_truck',   'Food Truck'),
  ('beauty_salon', 'Beauty Salon'),
  ('restaurant',   'Restaurant'),
  ('other',        'Other')
ON CONFLICT (key) DO NOTHING;

---------------------------
-- Core: Tenancy & Auth
---------------------------
CREATE TABLE tenants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  business_type_id  uuid REFERENCES business_types(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenants_business_type ON tenants(business_type_id);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'user',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

---------------------------
-- Customers (end-clients of tenants)
---------------------------
CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text,
  email         text,
  phone         text,
  company_name  text,
  tags          jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE INDEX idx_customers_tenant_email ON customers(tenant_id, email);

---------------------------
-- Catalog: Categories & Products
---------------------------
DO $$ BEGIN
  CREATE TYPE product_kind AS ENUM ('food','goods');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE product_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  slug       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        product_kind NOT NULL,                 -- 'food' or 'goods'
  sku         text,                                  -- optional unique per tenant
  category_id uuid REFERENCES product_categories(id) ON DELETE SET NULL,
  price       numeric(12,2),
  vat_rate    numeric(4,1) NOT NULL DEFAULT 2.6,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE INDEX idx_products_tenant_kind     ON products(tenant_id, kind);
CREATE INDEX idx_products_tenant_category ON products(tenant_id, category_id);
CREATE INDEX idx_products_tenant_created  ON products(tenant_id, created_at DESC);
CREATE INDEX idx_products_tenant_id       ON products(tenant_id, id);

---------------------------
-- Food: Allergens, Ingredients & Recipes
---------------------------
CREATE TABLE allergens (
  code text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE ingredients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  allergen_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE product_ingredients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id  uuid NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  quantity       numeric(12,3) NOT NULL CHECK (quantity >= 0),
  unit           text NOT NULL, -- 'g','ml','pcs'
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, ingredient_id)
);

CREATE INDEX idx_ingredients_tenant        ON ingredients(tenant_id);
CREATE INDEX idx_pingredients_tenant_prod  ON product_ingredients(tenant_id, product_id);
CREATE INDEX idx_pingredients_ingredient   ON product_ingredients(ingredient_id);

-- Enforce via trigger (no subquery CHECK):
-- - ingredient & product same tenant
-- - product.kind = 'food'
-- - set NEW.tenant_id from product
CREATE OR REPLACE FUNCTION trg_pingredients_enforce_fn()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prod_t uuid; ing_t uuid; prod_kind product_kind;
BEGIN
  SELECT tenant_id, kind INTO prod_t, prod_kind FROM products WHERE id = NEW.product_id;
  SELECT tenant_id            INTO ing_t                FROM ingredients WHERE id = NEW.ingredient_id;

  IF prod_t IS NULL THEN
    RAISE EXCEPTION 'product % does not exist', NEW.product_id;
  END IF;
  IF ing_t IS NULL THEN
    RAISE EXCEPTION 'ingredient % does not exist', NEW.ingredient_id;
  END IF;
  IF prod_kind <> 'food' THEN
    RAISE EXCEPTION 'only products with kind=food can have ingredients (product_id=% kind=%)', NEW.product_id, prod_kind;
  END IF;
  IF prod_t <> ing_t THEN
    RAISE EXCEPTION 'ingredient and product must belong to same tenant (product_tenant=% ingredient_tenant=%)', prod_t, ing_t;
  END IF;

  NEW.tenant_id := prod_t;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pingredients_enforce ON product_ingredients;
CREATE TRIGGER trg_pingredients_enforce
BEFORE INSERT OR UPDATE OF product_id, ingredient_id
ON product_ingredients
FOR EACH ROW EXECUTE FUNCTION trg_pingredients_enforce_fn();

-- Aggregated allergens per food product
CREATE OR REPLACE VIEW product_allergens AS
SELECT
  p.id AS product_id,
  p.tenant_id,
  ARRAY(SELECT DISTINCT unnest(i.allergen_codes)
        FROM product_ingredients pi
        JOIN ingredients i ON i.id = pi.ingredient_id
        WHERE pi.product_id = p.id) AS allergen_codes
FROM products p
WHERE p.kind = 'food';

---------------------------
-- Menus & Self-Ordering
---------------------------
DO $$ BEGIN
  CREATE TYPE self_order_status AS ENUM ('cart','placed','paid','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE menus (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,                 -- public URL: /m/:slug
  is_public   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug),
  UNIQUE (tenant_id, name)
);
CREATE INDEX idx_menu_slug ON menus(slug);

CREATE TABLE menu_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_id     uuid NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sort_index  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (menu_id, product_id)
);

CREATE TABLE tables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  room        text,
  qr_token    text NOT NULL,                 -- public URL: /t/:qr_token
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (qr_token),
  UNIQUE (tenant_id, name)
);

CREATE TABLE self_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_id          uuid NOT NULL REFERENCES menus(id) ON DELETE RESTRICT,
  table_id         uuid REFERENCES tables(id) ON DELETE SET NULL,
  status           self_order_status NOT NULL DEFAULT 'cart',
  currency         text NOT NULL DEFAULT 'CHF',
  subtotal         numeric(12,2) NOT NULL DEFAULT 0,
  vat_total        numeric(12,2) NOT NULL DEFAULT 0,
  grand_total      numeric(12,2) NOT NULL DEFAULT 0,
  payment_intent_id text,
  receipt_code     text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_self_orders_status ON self_orders(status);

CREATE TABLE self_order_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  self_order_id uuid NOT NULL REFERENCES self_orders(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty           numeric(12,2) NOT NULL CHECK (qty > 0),
  unit_price    numeric(12,2) NOT NULL,
  vat_rate      numeric(4,1)  NOT NULL,
  line_total    numeric(12,2) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_self_order_items_order ON self_order_items(self_order_id);

---------------------------
-- Backoffice Orders (minimal)
---------------------------
CREATE TABLE orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  total       numeric(12,2) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

---------------------------
-- Payments
---------------------------
DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('created','in_progress','approved','declined','cancelled','error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE payment_providers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider   text NOT NULL CHECK (provider IN ('wallee','sumup','worldline','nexi','paytec')),
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  active     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);
CREATE INDEX idx_payprov_tenant ON payment_providers (tenant_id);

CREATE TABLE terminals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('wallee','sumup','worldline','nexi','paytec')),
  external_id text,
  label       text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_terminals_tenant ON terminals (tenant_id);

CREATE TABLE payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('sumup','wallee','worldline','nexi','paytec')),
  terminal_id uuid REFERENCES terminals(id) ON DELETE SET NULL,
  amount      numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency    text NOT NULL DEFAULT 'CHF',
  external_id text,
  status      payment_status NOT NULL DEFAULT 'in_progress',
  receipt_ref text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_tenant ON payments (tenant_id);

CREATE TABLE payment_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pevents_payment ON payment_events (payment_id);

---------------------------
-- Services (Dienste)
---------------------------
DO $$ BEGIN
  CREATE TYPE booking_status AS ENUM ('draft','pending','confirmed','completed','cancelled','no_show');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE services (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               text NOT NULL,
  description        text,
  duration_min       int  NOT NULL CHECK (duration_min > 0),
  buffer_before_min  int  NOT NULL DEFAULT 0 CHECK (buffer_before_min >= 0),
  buffer_after_min   int  NOT NULL DEFAULT 0 CHECK (buffer_after_min  >= 0),
  price              numeric(12,2),
  currency           text NOT NULL DEFAULT 'CHF',
  color              text,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_services_tenant_active ON services(tenant_id, is_active);

---------------------------
-- Employees (Mitarbeiter) & Skills
---------------------------
CREATE TABLE employees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name    text,
  last_name     text,
  display_name  text NOT NULL,
  email         text,
  phone         text,
  role          text NOT NULL DEFAULT 'staff',
  color         text,
  is_active     boolean NOT NULL DEFAULT true,
  hired_at      date,
  terminated_at date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, display_name)
);
CREATE INDEX idx_employees_tenant_active ON employees(tenant_id, is_active);

CREATE TABLE employee_services (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  service_id   uuid NOT NULL REFERENCES services(id)  ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, service_id)
);
CREATE INDEX idx_emp_services_tenant ON employee_services(tenant_id, employee_id);

-- Consistency trigger: set tenant, ensure same tenant
CREATE OR REPLACE FUNCTION trg_emp_services_enforce_fn()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE emp_t uuid; svc_t uuid;
BEGIN
  SELECT tenant_id INTO emp_t FROM employees WHERE id = NEW.employee_id;
  SELECT tenant_id INTO svc_t FROM services  WHERE id = NEW.service_id;

  IF emp_t IS NULL THEN RAISE EXCEPTION 'employee % not found', NEW.employee_id; END IF;
  IF svc_t IS NULL THEN RAISE EXCEPTION 'service % not found', NEW.service_id; END IF;
  IF emp_t <> svc_t THEN
    RAISE EXCEPTION 'employee and service must belong to same tenant (emp=% svc=%)', emp_t, svc_t;
  END IF;

  NEW.tenant_id := emp_t;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_emp_services_enforce ON employee_services;
CREATE TRIGGER trg_emp_services_enforce
BEFORE INSERT OR UPDATE OF employee_id, service_id
ON employee_services
FOR EACH ROW EXECUTE FUNCTION trg_emp_services_enforce_fn();

---------------------------
-- Employee Availability (weekly pattern) & Time Off
---------------------------
CREATE TABLE employee_availability (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  weekday      smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sunday ... 6=Saturday
  start_time   time NOT NULL,
  end_time     time NOT NULL,
  location     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time < end_time)
);
CREATE INDEX idx_emp_avail_emp_day ON employee_availability(tenant_id, employee_id, weekday);

CREATE OR REPLACE FUNCTION trg_set_tenant_from_employee_fn()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE emp_t uuid;
BEGIN
  SELECT tenant_id INTO emp_t FROM employees WHERE id = NEW.employee_id;
  IF emp_t IS NULL THEN RAISE EXCEPTION 'employee % not found', NEW.employee_id; END IF;
  NEW.tenant_id := emp_t;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_avail_tenant ON employee_availability;
CREATE TRIGGER trg_avail_tenant
BEFORE INSERT OR UPDATE OF employee_id
ON employee_availability
FOR EACH ROW EXECUTE FUNCTION trg_set_tenant_from_employee_fn();

CREATE TABLE employee_time_off (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);
CREATE INDEX idx_emp_timeoff_emp ON employee_time_off(tenant_id, employee_id, starts_at);

DROP TRIGGER IF EXISTS trg_timeoff_tenant ON employee_time_off;
CREATE TRIGGER trg_timeoff_tenant
BEFORE INSERT OR UPDATE OF employee_id
ON employee_time_off
FOR EACH ROW EXECUTE FUNCTION trg_set_tenant_from_employee_fn();

---------------------------
-- Bookings & Links to Payments
---------------------------
CREATE TABLE bookings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id    uuid REFERENCES customers(id) ON DELETE SET NULL,
  service_id     uuid NOT NULL REFERENCES services(id)  ON DELETE RESTRICT,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  status         booking_status NOT NULL DEFAULT 'pending',
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz,
  price_total    numeric(12,2),
  currency       text NOT NULL DEFAULT 'CHF',
  source         text,
  notes          text,
  created_by     uuid,         -- user.id (optional; not FK-enforced)
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < COALESCE(ends_at, starts_at + interval '1 minute'))
);
CREATE INDEX idx_bookings_tenant_emp_start ON bookings(tenant_id, employee_id, starts_at);
CREATE INDEX idx_bookings_tenant_status    ON bookings(tenant_id, status);

CREATE TABLE booking_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  payment_id  uuid NOT NULL REFERENCES payments(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, payment_id)
);
CREATE INDEX idx_bpay_booking ON booking_payments(tenant_id, booking_id);

-- Booking enforcement:
-- - tenant from employee
-- - same tenant for service & customer
-- - ends_at default = starts_at + duration + buffers (if NULL)
-- - prevent overlap with other active bookings for same employee
-- - prevent overlap with employee_time_off
CREATE OR REPLACE FUNCTION trg_bookings_enforce_fn()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE emp_t uuid; svc_t uuid; cust_t uuid;
DECLARE dur int; buf_b int; buf_a int;
DECLARE has_overlap boolean;
DECLARE off_overlap boolean;
BEGIN
  SELECT tenant_id INTO emp_t FROM employees WHERE id = NEW.employee_id;
  IF emp_t IS NULL THEN RAISE EXCEPTION 'employee % not found', NEW.employee_id; END IF;
  NEW.tenant_id := emp_t;

  SELECT tenant_id, duration_min, buffer_before_min, buffer_after_min
    INTO svc_t, dur, buf_b, buf_a
  FROM services WHERE id = NEW.service_id;
  IF svc_t IS NULL THEN RAISE EXCEPTION 'service % not found', NEW.service_id; END IF;
  IF emp_t <> svc_t THEN RAISE EXCEPTION 'employee and service must belong to same tenant'; END IF;

  IF NEW.customer_id IS NOT NULL THEN
    SELECT tenant_id INTO cust_t FROM customers WHERE id = NEW.customer_id;
    IF cust_t IS NULL THEN RAISE EXCEPTION 'customer % not found', NEW.customer_id; END IF;
    IF cust_t <> emp_t THEN RAISE EXCEPTION 'customer must belong to same tenant'; END IF;
  END IF;

  IF NEW.ends_at IS NULL THEN
    NEW.ends_at := NEW.starts_at
                   + make_interval(mins => COALESCE(dur,0) + COALESCE(buf_b,0) + COALESCE(buf_a,0));
  END IF;

  IF NEW.starts_at >= NEW.ends_at THEN
    RAISE EXCEPTION 'starts_at must be before ends_at';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM bookings b
    WHERE b.tenant_id   = emp_t
      AND b.employee_id = NEW.employee_id
      AND b.id         <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND b.status NOT IN ('cancelled','no_show')
      AND NOT (NEW.ends_at <= b.starts_at OR NEW.starts_at >= b.ends_at)
  ) INTO has_overlap;

  IF has_overlap THEN
    RAISE EXCEPTION 'booking overlaps with another booking for this employee';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM employee_time_off t
    WHERE t.tenant_id   = emp_t
      AND t.employee_id = NEW.employee_id
      AND NOT (NEW.ends_at <= t.starts_at OR NEW.starts_at >= t.ends_at)
  ) INTO off_overlap;

  IF off_overlap THEN
    RAISE EXCEPTION 'booking overlaps with employee time off';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bookings_enforce ON bookings;
CREATE TRIGGER trg_bookings_enforce
BEFORE INSERT OR UPDATE OF employee_id, service_id, customer_id, starts_at, ends_at, status
ON bookings
FOR EACH ROW EXECUTE FUNCTION trg_bookings_enforce_fn();

---------------------------
-- Row Level Security
---------------------------
ALTER TABLE tenants               ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_categories    ENABLE ROW LEVEL SECURITY;
ALTER TABLE products              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_ingredients   ENABLE ROW LEVEL SECURITY;
ALTER TABLE menus                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables                ENABLE ROW LEVEL SECURITY;
ALTER TABLE self_orders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE self_order_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_providers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminals             ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE services              ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees             ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_services     ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_time_off     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings              ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_payments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE services              FORCE ROW LEVEL SECURITY;
ALTER TABLE employees             FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_services     FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_availability FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_time_off     FORCE ROW LEVEL SECURITY;
ALTER TABLE bookings              FORCE ROW LEVEL SECURITY;
ALTER TABLE booking_payments      FORCE ROW LEVEL SECURITY;


-- Force RLS where appropriate
ALTER TABLE products FORCE ROW LEVEL SECURITY;

-- Tenant policies (expects app.tenant_id to be set in session)
CREATE POLICY tenant_self ON tenants
  USING (id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY users_tenant ON users
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY customers_tenant ON customers
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY pcats_tenant ON product_categories
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY products_tenant ON products
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY ingredients_tenant ON ingredients
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY pingredients_tenant ON product_ingredients
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY menus_tenant ON menus
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY menu_items_tenant ON menu_items
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tables_tenant ON tables
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY self_orders_tenant ON self_orders
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY self_order_items_tenant ON self_order_items
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY orders_tenant ON orders
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY payprov_tenant ON payment_providers
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY terminals_tenant ON terminals
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY payments_tenant ON payments
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY pevents_tenant ON payment_events
  USING (payment_id IN (SELECT id FROM payments
                        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid))
  WITH CHECK (true);

CREATE POLICY services_tenant ON services
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY employees_tenant ON employees
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY emp_services_tenant ON employee_services
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY emp_avail_tenant ON employee_availability
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY emp_timeoff_tenant ON employee_time_off
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY bookings_tenant ON bookings
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY bpay_tenant ON booking_payments
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
