import {
  titleCase,
  CLASSIFICATION_STYLES,
  INTEGRITY_STYLES,
} from "../lib/format";

export function Badge({ children, className = "" }) {
  return (
    <span
      className={`inline-flex max-w-full items-center rounded border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

export function ClassificationBadge({ value }) {
  if (!value) return null;

  return (
    <Badge
      className={
        CLASSIFICATION_STYLES[value] ||
        "bg-slate-100 text-slate-700 border-slate-300"
      }
    >
      {value}
    </Badge>
  );
}

export function IntegrityBadge({ value }) {
  if (!value) return null;

  return (
    <Badge
      className={
        INTEGRITY_STYLES[value] ||
        "bg-slate-100 text-slate-700 border-slate-300"
      }
    >
      {value === "VERIFIED" ? "✓ " : value === "TAMPERED" ? "⚠ " : ""}
      {titleCase(value)}
    </Badge>
  );
}

export function StatusBadge({ value }) {
  if (!value) return null;

  return (
    <Badge className="bg-slate-100 text-slate-700 border-slate-300">
      {titleCase(value)}
    </Badge>
  );
}

export function Card({ children, className = "" }) {
  return (
    <div
      className={`min-w-0 rounded-lg border border-slate-200 bg-white shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-6 flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="wrap-break-words text-xl font-semibold text-slate-900">
          {title}
        </h1>

        {subtitle && (
          <p className="mt-1 wrap-break-words text-sm text-slate-500">
            {subtitle}
          </p>
        )}
      </div>

      {actions && (
        <div className="flex w-full min-w-0 flex-wrap gap-2 sm:w-auto sm:shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}) {
  const base =
    "rounded-md px-3.5 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

  const variants = {
    primary: "bg-blue-700 text-white hover:bg-blue-800",
    secondary:
      "border border-slate-300 text-slate-700 hover:bg-slate-50 bg-white",
    danger: "bg-red-700 text-white hover:bg-red-800",
    ghost: "text-slate-600 hover:bg-slate-100",
  };

  return (
    <button
      className={`${base} ${variants[variant] || variants.primary} ${className}`}
      {...props}
    />
  );
}

export function Input({
  label,
  error,
  className = "",
  id,
  ...props
}) {
  return (
    <label className="block min-w-0">
      {label && (
        <span className="mb-1 block wrap-break-words text-sm font-medium text-slate-700">
          {label}
        </span>
      )}

      <input
        id={id}
        className={`w-full min-w-0 rounded-md border px-3 py-2 text-sm focus:border-blue-600 ${
          error ? "border-red-400" : "border-slate-300"
        } ${className}`}
        {...props}
      />

      {error && (
        <span className="mt-1 block wrap-break-words text-xs text-red-600">
          {error}
        </span>
      )}
    </label>
  );
}

export function Select({
  label,
  error,
  children,
  className = "",
  ...props
}) {
  return (
    <label className="block min-w-0">
      {label && (
        <span className="mb-1 block wrap-break-words text-sm font-medium text-slate-700">
          {label}
        </span>
      )}

      <select
        className={`w-full min-w-0 rounded-md border px-3 py-2 text-sm focus:border-blue-600 ${
          error ? "border-red-400" : "border-slate-300"
        } ${className}`}
        {...props}
      >
        {children}
      </select>

      {error && (
        <span className="mt-1 block wrap-break-words text-xs text-red-600">
          {error}
        </span>
      )}
    </label>
  );
}

export function ErrorText({ children }) {
  if (!children) return null;

  return (
    <div className="min-w-0 wrap-break-words rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {children}
    </div>
  );
}

export function Spinner({ className = "" }) {
  return (
    <div
      className={`h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-blue-700 ${className}`}
    />
  );
}

export function EmptyState({ title, subtitle }) {
  return (
    <div className="flex min-w-0 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 px-4 py-14 text-center">
      <p className="wrap-break-words text-sm font-medium text-slate-700">
        {title}
      </p>

      {subtitle && (
        <p className="mt-1 wrap-break-words text-sm text-slate-500">
          {subtitle}
        </p>
      )}
    </div>
  );
}

export function apiErrorMessage(
  err,
  fallback = "Something went wrong. Please try again."
) {
  return err?.response?.data?.error?.message || fallback;
}