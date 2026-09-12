import { useReference } from "../lib/ReferenceContext";

import { Input, Select } from "./ui";

// Picks an orgId/jurisdictionId from the reference lists. If the current user
// can't read reference data (403 — see ReferenceContext), falls back to a raw
// UUID text field so the form is still usable rather than silently broken.
function ReferencePicker({
  label,
  items,
  forbidden,
  loading,
  value,
  onChange,
  required,
}) {
  if (forbidden) {
    return (
      <div className="w-full min-w-0">
        <Input
          label={label}
          required={required}
          placeholder="UUID (you don't have permission to browse the list)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  return (
    <div className="w-full min-w-0">
      <Select
        label={label}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">
          {loading ? "Loading…" : "Select…"}
        </option>

        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function OrgPicker({
  value,
  onChange,
  label = "Organization",
  required,
}) {
  const { orgs, loading, forbidden } = useReference();

  return (
    <ReferencePicker
      label={label}
      items={orgs}
      loading={loading}
      forbidden={forbidden}
      value={value}
      onChange={onChange}
      required={required}
    />
  );
}

export function JurisdictionPicker({
  value,
  onChange,
  label = "Jurisdiction",
  required,
}) {
  const { jurisdictions, loading, forbidden } = useReference();

  return (
    <ReferencePicker
      label={label}
      items={jurisdictions}
      loading={loading}
      forbidden={forbidden}
      value={value}
      onChange={onChange}
      required={required}
    />
  );
}