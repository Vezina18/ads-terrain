-- ADS Terrain: checklists de départ du matin (outils, matériel, machinerie, sécurité) par type de job
-- 1) Modèles génériques par type de job (modifiables), 2) items propres à chaque projet (tirés de la soumission retenue,
-- sans aucun prix), 3) cases cochées par jour.
create table if not exists depart_modeles (
  cle text primary key,            -- 'general' ou la clé du service du Masterapp (paysager, murs, gazon, terrassement, drainage, beton, demolition, heure)
  nom text not null,
  ordre int not null default 0,
  items jsonb not null default '[]'::jsonb   -- [{ "id": "g1", "texte": "...", "cat": "Outils" }]
);
create table if not exists depart_projet (
  projet_id text primary key,
  types text[] not null default '{}',
  extra jsonb not null default '[]'::jsonb,  -- [{ "id": "m-mp17", "texte": "Mini-pelle 1,7 tonne", "cat": "Machinerie" }]
  maj timestamptz not null default now()
);
create table if not exists depart_coches (
  projet_id text not null,
  jour date not null,
  item text not null,
  par text,
  cree_le timestamptz not null default now(),
  primary key (projet_id, jour, item)
);
alter table depart_modeles enable row level security;
alter table depart_projet enable row level security;
alter table depart_coches enable row level security;

-- Lecture pour l'app (employé connecté): modèles + items par projet + cases cochées aujourd'hui
create or replace function terrain_depart(p_token text, p_jour text) returns json
language plpgsql security definer set search_path to 'public' as $$
declare e employes; j date;
begin
  e := terrain_auth(p_token);
  begin j := p_jour::date; exception when others then j := current_date; end;
  return json_build_object(
    'jour', j,
    'modeles', coalesce((select json_agg(json_build_object('cle', cle, 'nom', nom, 'items', items) order by ordre, nom) from depart_modeles), '[]'::json),
    'projets', coalesce((select json_agg(json_build_object('projetId', projet_id, 'types', types, 'extra', extra)) from depart_projet), '[]'::json),
    'coches', coalesce((select json_agg(json_build_object('projetId', projet_id, 'item', item, 'par', par)) from depart_coches where jour = j), '[]'::json)
  );
end $$;

create or replace function terrain_depart_cocher(p_token text, p_projet text, p_item text, p_fait boolean, p_jour text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare e employes; j date;
begin
  e := terrain_auth(p_token);
  begin j := p_jour::date; exception when others then raise exception 'date_invalide'; end;
  if j < current_date - 1 or j > current_date + 1 then raise exception 'date_invalide'; end if;
  if p_fait then
    insert into depart_coches(projet_id, jour, item, par) values (p_projet, j, p_item, e.nom) on conflict (projet_id, jour, item) do nothing;
  else
    delete from depart_coches where projet_id = p_projet and jour = j and item = p_item;
  end if;
end $$;

-- Écriture réservée à l'admin (le Masterapp passe par le connecteur Supabase, jamais par l'app des employés)
create or replace function terrain_depart_projet_ecrire(p_projet text, p_types json, p_extra json) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if exists (select 1 from json_array_elements(coalesce(p_extra, '[]'::json)) x where (x::text) ~* '\$|[0-9]\s?\$|\mprix\M|\mtaxes?\M|\mtps\M|\mtvq\M') then
    raise exception 'prix_detecte';
  end if;
  insert into depart_projet(projet_id, types, extra, maj)
  values (p_projet, coalesce(array(select json_array_elements_text(coalesce(p_types, '[]'::json))), '{}'), coalesce(p_extra, '[]'::json)::jsonb, now())
  on conflict (projet_id) do update set types = excluded.types, extra = excluded.extra, maj = now();
end $$;
create or replace function terrain_depart_modele_ecrire(p_cle text, p_nom text, p_ordre int, p_items json) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  insert into depart_modeles(cle, nom, ordre, items) values (p_cle, p_nom, coalesce(p_ordre, 0), coalesce(p_items, '[]'::json)::jsonb)
  on conflict (cle) do update set nom = excluded.nom, ordre = excluded.ordre, items = excluded.items;
end $$;
revoke execute on function terrain_depart_projet_ecrire(text, json, json) from public, anon, authenticated;
revoke execute on function terrain_depart_modele_ecrire(text, text, int, json) from public, anon, authenticated;
grant execute on function terrain_depart(text, text) to anon, authenticated;
grant execute on function terrain_depart_cocher(text, text, text, boolean, text) to anon, authenticated;

-- Modèles de départ (point de départ à ajuster)
insert into depart_modeles(cle, nom, ordre, items) values
('general', 'Tous les chantiers', 0, '[
 {"id":"g1","cat":"Sécurité","texte":"Bottes de sécurité, gants, lunettes"},
 {"id":"g2","cat":"Sécurité","texte":"Trousse de premiers soins dans le camion"},
 {"id":"g3","cat":"Sécurité","texte":"Eau potable et dîners pour la journée"},
 {"id":"g4","cat":"Outils","texte":"Pelles (ronde et carrée), râteaux, brouette"},
 {"id":"g5","cat":"Outils","texte":"Niveau, ruban à mesurer, cordeau et piquets"},
 {"id":"g6","cat":"Outils","texte":"Sangles et chaînes d''arrimage"},
 {"id":"g7","cat":"Machinerie","texte":"Plein d''essence : camion, machines et jerrican"},
 {"id":"g8","cat":"Autre","texte":"Adresse et détails de la soumission consultés (onglet Travaux)"},
 {"id":"g9","cat":"Autre","texte":"Cellulaire chargé"}
]'::jsonb),
('paysager', 'Pavé-uni & dalles', 1, '[
 {"id":"p1","cat":"Outils","texte":"Plaque vibrante (avec la plaque caoutchouc pour le pavé)"},
 {"id":"p2","cat":"Outils","texte":"Scie à pavé, lames de rechange et eau"},
 {"id":"p3","cat":"Outils","texte":"Maillet de caoutchouc, règle d''aluminium et rails de nivellement"},
 {"id":"p4","cat":"Outils","texte":"Niveau 4 pi, niveau laser et mire"},
 {"id":"p5","cat":"Outils","texte":"Balai, souffleur et pinces à pavé"},
 {"id":"p6","cat":"Matériel","texte":"Pierre concassée de fondation (0-3/4)"},
 {"id":"p7","cat":"Matériel","texte":"Sable de nivellement (lit de pose)"},
 {"id":"p8","cat":"Matériel","texte":"Sable polymère"},
 {"id":"p9","cat":"Matériel","texte":"Bordures, clous de bordure et membrane géotextile"},
 {"id":"p10","cat":"Matériel","texte":"Colle PL et pistolet"}
]'::jsonb),
('murs', 'Murets & escaliers', 2, '[
 {"id":"m1","cat":"Outils","texte":"Scie à béton ou coupe-bloc, lames et eau"},
 {"id":"m2","cat":"Outils","texte":"Maillet, niveau 4 pi et niveau laser"},
 {"id":"m3","cat":"Outils","texte":"Plaque vibrante ou pilon (tamper)"},
 {"id":"m4","cat":"Matériel","texte":"Blocs de mur, couronnement et coins"},
 {"id":"m5","cat":"Matériel","texte":"Pierre nette 3/4 (drainage et remplissage)"},
 {"id":"m6","cat":"Matériel","texte":"Membrane géotextile et tuyau de drain"},
 {"id":"m7","cat":"Matériel","texte":"Colle PL, pistolet et grillage ou géogrille au besoin"}
]'::jsonb),
('gazon', 'Terre, tourbe & semis', 3, '[
 {"id":"z1","cat":"Outils","texte":"Râteau à gazon, rouleau et épandeur"},
 {"id":"z2","cat":"Outils","texte":"Boyau d''arrosage et gicleur"},
 {"id":"z3","cat":"Matériel","texte":"Terre ou terreau"},
 {"id":"z4","cat":"Matériel","texte":"Tourbe ou semence à gazon"},
 {"id":"z5","cat":"Matériel","texte":"Engrais de démarrage"}
]'::jsonb),
('terrassement', 'Excavation & terrassement', 4, '[
 {"id":"t1","cat":"Machinerie","texte":"Godets de la mini-pelle, graisse et huile vérifiées"},
 {"id":"t2","cat":"Machinerie","texte":"Remorque, rampes et sangles pour la machine"},
 {"id":"t3","cat":"Outils","texte":"Niveau laser, mire et ruban à mesurer"},
 {"id":"t4","cat":"Outils","texte":"Piquets, peinture de marquage et cônes"},
 {"id":"t5","cat":"Sécurité","texte":"Localisation Info-Excavation confirmée"}
]'::jsonb),
('drainage', 'Drainage', 5, '[
 {"id":"d1","cat":"Outils","texte":"Niveau laser ou niveau de pente et mire"},
 {"id":"d2","cat":"Outils","texte":"Scie ou coupe-tuyau"},
 {"id":"d3","cat":"Matériel","texte":"Tuyau de drain perforé et chaussette"},
 {"id":"d4","cat":"Matériel","texte":"Raccords, coudes et regard de nettoyage"},
 {"id":"d5","cat":"Matériel","texte":"Pierre nette 3/4 et membrane géotextile"}
]'::jsonb),
('beton', 'Béton (coulée, sciage)', 6, '[
 {"id":"b1","cat":"Outils","texte":"Scie à béton, lames de rechange et eau"},
 {"id":"b2","cat":"Outils","texte":"Truelles, règle (screed) et flotte"},
 {"id":"b3","cat":"Sécurité","texte":"Masque anti-poussière et protection auditive"},
 {"id":"b4","cat":"Matériel","texte":"Coffrage (2x4 ou 2x6), piquets et vis"},
 {"id":"b5","cat":"Matériel","texte":"Treillis ou barres d''armature et chaises"},
 {"id":"b6","cat":"Matériel","texte":"Membrane de polyéthylène et produit de cure"}
]'::jsonb),
('demolition', 'Démolition & disposition', 7, '[
 {"id":"x1","cat":"Outils","texte":"Marteau-piqueur ou brise-béton, burins et masse"},
 {"id":"x2","cat":"Outils","texte":"Barre à clous (pied-de-biche) et pic"},
 {"id":"x3","cat":"Sécurité","texte":"Masque anti-poussière, protection auditive et lunettes"},
 {"id":"x4","cat":"Matériel","texte":"Bâches et sacs à gravats"},
 {"id":"x5","cat":"Autre","texte":"Disposition prévue (conteneur ou voyage au dépôt)"}
]'::jsonb),
('heure', 'Travaux à l''heure', 8, '[
 {"id":"h1","cat":"Autre","texte":"Noter la machinerie utilisée et les achats de matériel (facturés au coûtant)"}
]'::jsonb)
on conflict (cle) do nothing;
