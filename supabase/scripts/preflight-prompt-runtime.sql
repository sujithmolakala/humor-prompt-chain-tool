-- READ ONLY. Run manually in the project's SQL Editor as postgres before review.
with required(relation,column_name,type_name) as (values
 ('prompt_chains','id','uuid'),('prompt_chains','name','text'),('prompt_chains','description','text'),
 ('prompt_chain_steps','id','uuid'),('prompt_chain_steps','chain_id','uuid'),('prompt_chain_steps','position','integer'),('prompt_chain_steps','prompt_template','text'),('prompt_chain_steps','model_id','uuid'),
 ('prompt_chain_mix','chain_id','uuid'),('prompt_chain_mix','allocation','numeric'),('prompt_chain_mix','enabled','boolean'),
 ('llm_models','id','uuid'),('llm_models','identifier','text'),('llm_models','provider_id','uuid'),('llm_models','enabled','boolean'),('llm_models','temperature','numeric'),('llm_models','max_tokens','integer'),
 ('caption_generation_requests','user_id','uuid'),('caption_generation_requests','request_id','uuid'),('caption_generation_requests','status','text'),('caption_generation_requests','day','date'),
 ('caption_generation_days','used','integer'),('caption_generation_days','dispatched','integer')
), checks as (
 select 'PostgreSQL 15+' name,current_setting('server_version_num')::integer>=150000 ok,current_setting('server_version') details
 union all
 select r.relation||'.'||r.column_name,exists(select 1 from pg_attribute a where a.attrelid=to_regclass('public.'||r.relation) and a.attname=r.column_name and format_type(a.atttypid,a.atttypmod)=r.type_name and not a.attisdropped),'Expected '||r.type_name from required r
 union all
 select 'admin_assert security',exists(select 1 from pg_proc where oid=to_regprocedure('public.admin_assert()') and prosecdef and proowner='postgres'::regrole and proconfig @> array['search_path=""']),'Existing superadmin helper must be postgres-owned SECURITY DEFINER with empty search_path'
 union all
 select 'Legacy generation completion',to_regprocedure('public.caption_generation_finish(uuid,uuid,text[],text,text,boolean)') is not null,'Existing quota/draft completion helper'
 union all
 select 'Existing catalog RLS',not exists(select 1 from pg_class where oid in (to_regclass('public.prompt_chains'),to_regclass('public.prompt_chain_steps'),to_regclass('public.prompt_chain_mix'),to_regclass('public.llm_models'),to_regclass('public.llm_providers')) and not relrowsecurity),'No existing catalog RLS may be disabled'
)
select name,case when ok then 'PASS' else 'FAIL' end status,details from checks order by name;

-- Actual current mix and models; this does not activate anything or print templates.
select c.id,c.name,m.enabled,m.allocation,count(s.id) steps,
       array_agg(s.position order by s.position) filter(where s.id is not null) positions,
       count(*) filter(where s.id is not null and s.model_id is null) default_model_assignments
from public.prompt_chains c left join public.prompt_chain_mix m on m.chain_id=c.id
left join public.prompt_chain_steps s on s.chain_id=c.id
group by c.id,c.name,m.enabled,m.allocation order by c.name;
select m.id,m.name,m.identifier,m.enabled,p.name provider,p.enabled provider_enabled,m.max_tokens
from public.llm_models m join public.llm_providers p on p.id=m.provider_id order by m.name;
