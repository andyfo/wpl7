// @docs security/site-protection
import {
  FIELD_OPS,
  HTTP_METHODS,
  MAX_CUSTOM_RULES,
  MAX_RULE_CONDITIONS,
  customRuleFields,
  customRuleSchema,
  type CustomCondition,
  type CustomRule,
  type CustomRuleField,
  type CustomRuleOp,
} from '../../../../shared/security';
import { Button, Segmented, Toggle, compactInputClass, inputClass } from '../ui';

/** A rule being edited: an id only once the panel has given it one. */
export type DraftRule = Omit<CustomRule, 'id'> & { id?: string };

const FIELD_LABELS: Record<CustomRuleField, string> = {
  path: 'Path',
  userAgent: 'User agent',
  method: 'Method',
  query: 'Query parameter',
  address: 'Address',
};
const OP_LABELS: Record<CustomRuleOp, string> = {
  is: 'is',
  startsWith: 'starts with',
  contains: 'contains',
  matches: 'matches (regex)',
  present: 'is present',
};

const blankCondition = (): CustomCondition => ({ field: 'path', op: 'startsWith', value: '/', negate: false });
const blankRule = (): DraftRule => ({ action: 'block', match: 'all', conditions: [blankCondition()], note: '', enabled: true });

/** What is wrong with a rule, in the words the panel would refuse it with; [] when nothing. */
export function ruleProblems(rule: DraftRule): string[] {
  const res = customRuleSchema.safeParse(rule);
  if (res.success) return [];
  return res.error.issues.map((i) => {
    const at = i.path[0] === 'conditions' && typeof i.path[1] === 'number' ? `Condition ${i.path[1] + 1}: ` : '';
    return `${at}${i.message}`;
  });
}

/**
 * The site's own rules: block or allow, when all (or any) of up to eight conditions hold.
 * Never Traefik's syntax - the panel writes that, escaping every value - and one router per
 * rule, so a rule Traefik refuses takes nothing else down with it.
 */
export function CustomRulesEditor({
  rules,
  onChange,
  hits,
}: {
  rules: DraftRule[];
  onChange: (next: DraftRule[]) => void;
  hits?: Record<string, number>;
}) {
  const update = (i: number, next: DraftRule) => onChange(rules.map((r, j) => (j === i ? next : r)));
  return (
    <div className="space-y-4">
      {rules.length === 0 && (
        <p className="text-sm text-neutral-500">
          None. A rule refuses (or lets through, ahead of every other rule) the requests that match it - by path, user
          agent, method, query parameter or address.
        </p>
      )}
      {rules.map((rule, i) => {
        const problems = ruleProblems(rule);
        const count = rule.id && hits ? (hits[`block-${rule.id}`] ?? 0) : 0;
        return (
          <div key={rule.id ?? `new-${i}`} className="rounded-lg border border-neutral-200 p-3">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                small
                label="Action"
                options={[
                  { id: 'block', label: 'Block' },
                  { id: 'allow', label: 'Allow', title: 'Let it through ahead of every other rule and limit' },
                ]}
                value={rule.action}
                onChange={(action) => update(i, { ...rule, action })}
              />
              <span className="text-xs text-neutral-500">when</span>
              <Segmented
                small
                label="Match"
                options={[
                  { id: 'all', label: 'all' },
                  { id: 'any', label: 'any' },
                ]}
                value={rule.match}
                onChange={(match) => update(i, { ...rule, match })}
              />
              <span className="text-xs text-neutral-500">of these hold</span>
              <div className="ml-auto flex items-center gap-2">
                {count > 0 && <span className="text-[11px] text-neutral-400">{count.toLocaleString()} blocked in 7 days</span>}
                <Toggle checked={rule.enabled} onChange={(enabled) => update(i, { ...rule, enabled })} label={<span className="text-xs">On</span>} />
                <Button small variant="ghost" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            </div>
            <div className="mt-2 space-y-2">
              {rule.conditions.map((c, k) => (
                <ConditionRow
                  key={k}
                  condition={c}
                  onChange={(next) => update(i, { ...rule, conditions: rule.conditions.map((x, m) => (m === k ? next : x)) })}
                  onRemove={rule.conditions.length > 1 ? () => update(i, { ...rule, conditions: rule.conditions.filter((_, m) => m !== k) }) : undefined}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {rule.conditions.length < MAX_RULE_CONDITIONS && (
                <Button small variant="secondary" onClick={() => update(i, { ...rule, conditions: [...rule.conditions, blankCondition()] })}>
                  Add a condition
                </Button>
              )}
              <input
                className={`${inputClass} max-w-sm`}
                placeholder="Note (what it is for)"
                maxLength={200}
                value={rule.note}
                onChange={(e) => update(i, { ...rule, note: e.target.value })}
              />
            </div>
            {problems.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-red-700">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {rules.length < MAX_CUSTOM_RULES && (
        <Button small variant="secondary" onClick={() => onChange([...rules, blankRule()])}>
          Add a rule
        </Button>
      )}
    </div>
  );
}

function ConditionRow({
  condition: c,
  onChange,
  onRemove,
}: {
  condition: CustomCondition;
  onChange: (next: CustomCondition) => void;
  onRemove?: () => void;
}) {
  const setField = (field: CustomRuleField) => {
    const op = FIELD_OPS[field].includes(c.op) ? c.op : FIELD_OPS[field][0]!;
    onChange({
      field,
      op,
      value: field === 'method' ? 'POST' : field === 'path' ? '/' : '',
      negate: c.negate,
      ...(field === 'query' ? { name: c.name ?? '' } : {}),
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Field" className={`${compactInputClass} w-40`} value={c.field} onChange={(e) => setField(e.target.value as CustomRuleField)}>
        {customRuleFields.map((f) => (
          <option key={f} value={f}>
            {FIELD_LABELS[f]}
          </option>
        ))}
      </select>
      {c.field === 'query' && (
        <input aria-label="Parameter name" className={`${compactInputClass} w-32`} placeholder="name" value={c.name ?? ''} onChange={(e) => onChange({ ...c, name: e.target.value })} />
      )}
      <label className="flex items-center gap-1 text-xs text-neutral-600">
        <input type="checkbox" checked={c.negate} onChange={(e) => onChange({ ...c, negate: e.target.checked })} />
        not
      </label>
      <select aria-label="Operator" className={`${compactInputClass} w-40`} value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as CustomRuleOp })}>
        {FIELD_OPS[c.field].map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op]}
          </option>
        ))}
      </select>
      {c.op !== 'present' &&
        (c.field === 'method' ? (
          <select aria-label="Method" className={`${compactInputClass} w-28`} value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })}>
            {HTTP_METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        ) : (
          <input
            aria-label="Value"
            className={`${compactInputClass} min-w-48 max-w-sm flex-1 font-mono text-xs`}
            placeholder={c.field === 'address' ? '203.0.113.0/24' : c.field === 'userAgent' ? 'BadBot' : '/private/'}
            maxLength={200}
            value={c.value}
            onChange={(e) => onChange({ ...c, value: e.target.value })}
          />
        ))}
      {onRemove && (
        <Button small variant="ghost" onClick={onRemove}>
          ✕
        </Button>
      )}
    </div>
  );
}
