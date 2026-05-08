-- Sub-projeto 13 — auto-classified library
alter table articles
  add column theme text not null default 'Outros',
  add column summary text;

alter table articles
  add constraint articles_theme_check
    check (theme in (
      'Kraljic',
      'Sourcing Estratégico',
      'SRM',
      'TCO',
      'Sustentabilidade',
      'Risco / Resiliência',
      'Negociação / Contratos',
      'Performance / KPIs',
      'Digital / Tecnologia',
      'Setor Público',
      'Outros'
    ));

create index articles_theme_idx on articles (theme);
