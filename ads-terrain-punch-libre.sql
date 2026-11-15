-- Terrain 4.1: punch sans projet + corrections d'heures sur 14 jours (appliqué via migration terrain_punch_sans_projet)
alter table punch_ouvert alter column projet_id drop not null;
-- terrain_punch_in / terrain_heure_save: nullif(p_projet,''); fenêtre date -14 jours; terrain_heure_delete: -14 jours
