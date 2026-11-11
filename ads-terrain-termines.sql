-- terrain_charger: ajoute "termines" (projets au statut Terminé) pour pouvoir les consulter / y revenir. "projets" reste = actifs seulement.
create or replace function public.terrain_projet_json(p projets) returns json language sql stable
set search_path to 'public','extensions' as $f$
  select json_build_object(
    'id', p.id, 'nomDossier', p.nom_dossier, 'adresse', p.adresse, 'status', p.status,
    'checklist', coalesce((select json_agg(json_build_object(
        'id', c.id, 'text', c.texte, 'done', c.fait, 'completedBy', c.fait_par,
        'completedAt', (extract(epoch from c.fait_le) * 1000)::bigint) order by c.ordre)
      from checklist c where c.projet_id = p.id), '[]'::json),
    'journal', coalesce((select json_agg(json_build_object(
        'id', j.id, 'author', j.auteur, 'text', j.texte, 'photoId', j.photo_id,
        'createdAt', (extract(epoch from j.cree_le) * 1000)::bigint) order by j.cree_le)
      from journal j where j.projet_id = p.id), '[]'::json),
    'estime', p.estime, 'driveUrl', p.drive_url,
    'fichiers', coalesce((select json_agg(json_build_object('id', f.id, 'nom', f.nom, 'mime', f.mime, 'taille', f.taille) order by f.cree_le) from fichiers_terrain f where f.projet_id = p.id), '[]'::json),
    'nbPhotos', (select count(*) from photos x where x.projet_id = p.id and x.journal_id is null)
  ) $f$;

-- terrain_charger: ajoute 'termines' (projets au statut Terminé) pour pouvoir les consulter / y revenir.
-- 'projets' reste inchangé (actifs seulement) : punch, départ du matin, etc. ne changent pas.
create or replace function public.terrain_charger(p_token text)
 returns json language plpgsql security definer set search_path to 'public','extensions'
as $function$
declare e employes;
begin
  e := terrain_auth(p_token);
  return json_build_object(
    'now', (extract(epoch from now()) * 1000)::bigint,
    'employe', json_build_object('id', e.id, 'nom', e.nom, 'role', e.role),
    'projets', coalesce((
      select json_agg(terrain_projet_json(p) order by p.nom_dossier)
      from projets p where p.status <> 'Terminé'), '[]'::json),
    'termines', coalesce((
      select json_agg(terrain_projet_json(p) order by p.nom_dossier desc)
      from projets p where p.status = 'Terminé'), '[]'::json),
    'agenda', coalesce((select json_agg(json_build_object('id', a.id, 'titre', a.titre, 'debut', a.debut, 'fin', a.fin,
              'equipe', a.equipe, 'projetId', a.projet_id) order by a.debut, a.titre)
            from agenda a where a.fin > current_date - 90), '[]'::json),
    'punch', (select json_build_object('projetId', o.projet_id, 'start', o.debut_ms, 'pauseMs', o.pause_ms, 'pauseStart', o.pause_debut_ms)
                from punch_ouvert o where o.employe_id = e.id),
    'heures', coalesce((
      select json_agg(json_build_object(
        'id', h.id, 'date', h.jour, 'projetId', h.projet_id, 'debut', h.debut, 'fin', h.fin,
        'pause', h.pause_min, 'heures', h.heures, 'notes', h.notes,
        'modifie', h.modifie, 'manuel', h.manuel) order by h.jour, h.cree_le)
      from heures h where h.employe_id = e.id and h.jour >= current_date - 21), '[]'::json)
  );
end $function$;
