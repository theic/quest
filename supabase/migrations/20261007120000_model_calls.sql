-- Messaging Quest v2: what every model call used and cost, to see where the money goes.
--
-- One row per call, from OpenRouter's own usage (its cost included), written best effort by the
-- agent (`infra/pg-spend.ts`). Never shown to the customer. `mq.model_spend` sums the rows by day,
-- customer, agent and model; `cache_share` is the part of the input read from the provider's cache,
-- billed at about a hundredth of the input price on MiMo. Rows are kept 30 days.

create table mq.model_calls (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  -- Null for a call made for nobody in particular (a browser picture checked on its own).
  customer_id uuid references mq.customers (id) on delete cascade,
  task_id uuid references mq.tasks (id) on delete set null,
  agent text not null,
  model text,
  ms int not null,
  input_tokens int not null,
  cached_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  output_tokens int not null,
  reasoning_tokens int not null default 0,
  cost numeric(12, 8)
);
create index model_calls_at on mq.model_calls (at);
create index model_calls_customer on mq.model_calls (customer_id, at);

create view mq.model_spend with (security_invoker = true) as
select date_trunc('day', at) as day,
       customer_id,
       agent,
       model,
       count(*)::int as calls,
       sum(input_tokens)::bigint as input_tokens,
       sum(cached_tokens)::bigint as cached_tokens,
       sum(output_tokens)::bigint as output_tokens,
       sum(reasoning_tokens)::bigint as reasoning_tokens,
       round(sum(cached_tokens)::numeric / nullif(sum(input_tokens), 0), 3) as cache_share,
       sum(cost) as cost
  from mq.model_calls
 group by 1, 2, 3, 4;

grant select, insert on mq.model_calls to mq_app;
grant select on mq.model_spend to mq_app;

select cron.schedule('mq-forget-model-calls', '23 3 * * *', $$delete from mq.model_calls where at < now() - interval '30 days'$$);
