-- ADS Terrain: heures de machinerie par projet (début / fin)
create table if not exists machine_heures (
  id text primary key,
  projet_id text not null,
  machine text not null,
  jour date not null,
  debut text not null,
  fin text,
  employe_id uuid,
  par text,
  cree_le timestamptz not null default now()
);
create index if not exists machine_heures_projet on machine_heures(projet_id, jour desc);
alter table machine_heures enable row level security;

create or replace function terrain_machines(p_token text, p_projet text) returns json
language plpgsql security definer set search_path to 'public' as $$
declare e employes;
begin
  e := terrain_auth(p_token);
  return coalesce((select json_agg(json_build_object('id', id, 'machine', machine, 'jour', jour, 'debut', debut, 'fin', fin,
            'par', par, 'mine', (employe_id = e.id)) order by jour desc, debut desc)
          from machine_heures where projet_id = p_projet), '[]'::json);
end $$;

create or replace function terrain_machine_save(p_token text, p_projet text, p_id text, p_machine text, p_jour text, p_debut text, p_fin text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare e employes; j date; ex machine_heures;
begin
  e := terrain_auth(p_token);
  begin j := p_jour::date; exception when others then raise exception 'date_invalide'; end;
  if j < current_date - 7 or j > current_date + 1 then raise exception 'date_invalide'; end if;
  if p_debut !~ '^[0-2][0-9]:[0-5][0-9]$' or (coalesce(p_fin,'') <> '' and p_fin !~ '^[0-2][0-9]:[0-5][0-9]$') then raise exception 'heure_invalide'; end if;
  if coalesce(trim(p_machine),'') = '' then raise exception 'machine_invalide'; end if;
  select * into ex from machine_heures where id = p_id;
  if found then
    if ex.employe_id is distinct from e.id and e.role not in ('admin','sync') then raise exception 'acces_refuse'; end if;
    update machine_heures set machine = p_machine, jour = j, debut = p_debut, fin = nullif(p_fin,'') where id = p_id;
  else
    insert into machine_heures(id, projet_id, machine, jour, debut, fin, employe_id, par)
    values (p_id, p_projet, p_machine, j, p_debut, nullif(p_fin,''), e.id, e.nom);
  end if;
end $$;

create or replace function terrain_machine_delete(p_token text, p_id text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare e employes;
begin
  e := terrain_auth(p_token);
  delete from machine_heures where id = p_id and (employe_id = e.id or e.role in ('admin','sync'));
end $$;
