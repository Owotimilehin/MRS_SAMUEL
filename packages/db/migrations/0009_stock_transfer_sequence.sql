-- Hand-written companion to 0008_cultured_speed.sql (the stock_transfer schema).
-- Creates the sequence used to mint human-readable transfer numbers like
-- "TRF-2026-00042". The domain layer calls nextval() inside the dispatch
-- transaction so the number is locked atomically with the row.

CREATE SEQUENCE IF NOT EXISTS stock_transfer_seq START 1 INCREMENT 1;
