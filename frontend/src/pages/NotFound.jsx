import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center text-center">
      <p className="text-4xl font-semibold text-slate-300">404</p>
      <p className="mt-2 text-sm text-slate-500">Page not found.</p>
      <Link to="/" className="mt-4 text-sm font-medium text-blue-700 hover:underline">
        Back to cases
      </Link>
    </div>
  );
}
