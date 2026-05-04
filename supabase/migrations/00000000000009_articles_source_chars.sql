-- Sub-projeto 10: source_chars permite calcular % de absorção do texto na UI admin.
-- Backfill é trivial porque raw_md (NOT NULL desde a init) já guarda o texto parseado.

alter table articles add column source_chars int;

update articles set source_chars = length(raw_md) where source_chars is null;

alter table articles alter column source_chars set not null;
