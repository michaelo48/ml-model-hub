-- OAuth providers (GitHub) put the name under different metadata keys than our
-- email signup form does. Fall back through them before using the email prefix.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),  -- our signup form
      nullif(new.raw_user_meta_data ->> 'full_name', ''),     -- GitHub display name
      nullif(new.raw_user_meta_data ->> 'name', ''),
      nullif(new.raw_user_meta_data ->> 'user_name', ''),     -- GitHub handle
      nullif(new.raw_user_meta_data ->> 'preferred_username', ''),
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
