-- Companion to 0011: sequence for human-readable order numbers like
-- "SO-2026-00731". Domain helper nextOrderNumber() calls nextval() inside
-- the confirm transaction so the order id and number are bound atomically.

CREATE SEQUENCE IF NOT EXISTS sale_order_seq START 1 INCREMENT 1;
