 
import { useCallback, useEffect, useState } from "react"; 
 
import { Link } from "react-router-dom"; 
 
import { api } from "../../lib/api"; 
 
import { 
  CASE_STATUSES, 
  CLASSIFICATIONS, 
  formatDate, 
  titleCase, 
} from "../../lib/format"; 
 
import { 
  Badge, 
  Button, 
  Card, 
  ClassificationBadge, 
  EmptyState, 
  ErrorText, 
  Input, 
  PageHeader, 
  Select, 
  Spinner, 
  apiErrorMessage, 
} from "../../components/ui"; 
 
import { Can } from "../../components/guards"; 
 
import NewCaseDialog from "./NewCaseDialog"; 
 
export default function CasesList() { 
  const [items, setItems] = useState([]); 
  const [total, setTotal] = useState(0); 
  const [page, setPage] = useState(1); 
  const [q, setQ] = useState(""); 
  const [status, setStatus] = useState(""); 
  const [assignedToMe, setAssignedToMe] = useState(false); 
  const [loading, setLoading] = useState(true); 
  const [error, setError] = useState(""); 
  const [showNew, setShowNew] = useState(false); 
 
  const pageSize = 20; 
 
  const load = useCallback(async () => { 
    setLoading(true); 
    setError(""); 
 
    try { 
      const res = await api.get("/cases", { 
        params: { 
          page, 
          pageSize, 
          q: q || undefined, 
          status: status || undefined, 
          assignedToMe: assignedToMe || undefined, 
        }, 
      }); 
 
      setItems(res.data.items); 
      setTotal(res.data.total); 
    } catch (err) { 
      setError(apiErrorMessage(err, "Could not load cases.")); 
    } finally { 
      setLoading(false); 
    } 
  }, [page, q, status, assignedToMe]); 
 
  useEffect(() => { 
    load(); 
  }, [load]); 
 
  const totalPages = Math.max(1, Math.ceil(total / pageSize)); 
 
  return ( 
    <div className="w-full min-w-0"> 
      <PageHeader 
        title="Cases" 
        subtitle="Search across cases you have access to." 
        actions={ 
          <Can permission="case:create"> 
            <Button onClick={() => setShowNew(true)}>New case</Button> 
          </Can> 
        } 
      /> 
 
      <Card className="mb-4 p-4"> 
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"> 
          <div className="w-full min-w-0 flex-1 sm:min-w-220px"> 
            <Input 
              label="Search" 
              placeholder="Case number, title…" 
              value={q} 
              onChange={(e) => { 
                setPage(1); 
                setQ(e.target.value); 
              }} 
            /> 
          </div> 
 
          <div className="w-full sm:w-48"> 
            <Select 
              label="Status" 
              value={status} 
              onChange={(e) => { 
                setPage(1); 
                setStatus(e.target.value); 
              }} 
            > 
              <option value="">All statuses</option> 
 
              {CASE_STATUSES.map((s) => ( 
                <option key={s} value={s}> 
                  {titleCase(s)} 
                </option> 
              ))} 
            </Select> 
          </div> 
 
          <label className="mb-0.5 flex items-center gap-2 pb-2 text-sm text-slate-700"> 
            <input 
              type="checkbox" 
              checked={assignedToMe} 
              onChange={(e) => { 
                setPage(1); 
                setAssignedToMe(e.target.checked); 
              }} 
            /> 
 
            
          </label> 
        </div> 
      </Card> 
 
      <ErrorText>{error}</ErrorText> 
 
      {loading ? ( 
        <div className="flex justify-center py-16"> 
          <Spinner /> 
        </div> 
      ) : items.length === 0 ? ( 
        <EmptyState 
          title="No cases found" 
          subtitle="Try adjusting your search or filters." 
        /> 
      ) : ( 
        <Card className="overflow-hidden"> 
          {/* Only the table scrolls horizontally on smaller screens */} 
          <div className="w-full overflow-x-auto"> 
            <table className="w-full min-w-700px text-left text-sm"> 
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500"> 
                <tr> 
                  <th className="whitespace-nowrap px-4 py-3"> 
                    Case # 
                  </th> 
 
                  <th className="px-4 py-3"> 
                    Title 
                  </th> 
 
                  <th className="whitespace-nowrap px-4 py-3"> 
                    Status 
                  </th> 
 
                  <th className="whitespace-nowrap px-4 py-3"> 
                    Classification 
                  </th> 
 
                  <th className="whitespace-nowrap px-4 py-3"> 
                    Docs 
                  </th> 
 
                  <th className="whitespace-nowrap px-4 py-3"> 
                    Updated 
                  </th> 
                </tr> 
              </thead> 
 
              <tbody className="divide-y divide-slate-100"> 
                {items.map((c) => ( 
                  <tr 
                    key={c.id} 
                    className="hover:bg-slate-50" 
                  > 
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900"> 
                      <Link 
                        to={`/cases/${c.id}`} 
                        className="text-blue-700 hover:underline" 
                      > 
                        {c.caseNumber} 
                      </Link> 
                    </td> 
 
                    <td className="px-4 py-3 text-slate-700"> 
                      {c.title} 
                    </td> 
 
                    <td className="px-4 py-3"> 
                      <Badge className="whitespace-nowrap border-slate-300 bg-slate-100 text-slate-700"> 
                        {titleCase(c.status)} 
                      </Badge> 
                    </td> 
 
                    <td className="px-4 py-3"> 
                      <ClassificationBadge 
                        value={c.classification} 
                      /> 
                    </td> 
 
                    <td className="px-4 py-3 text-slate-600"> 
                      {c.documentCount} 
                    </td> 
 
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500"> 
                      {formatDate(c.updatedAt)} 
                    </td> 
                  </tr> 
                ))} 
              </tbody> 
            </table> 
          </div> 
        </Card> 
      )} 
 
      {totalPages > 1 && ( 
        <div className="mt-4 flex flex-col gap-3 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between"> 
          <span> 
            Page {page} of {totalPages} · {total} cases 
          </span> 
 
          <div className="flex gap-2"> 
            <Button 
              variant="secondary" 
              disabled={page <= 1} 
              onClick={() => setPage((p) => p - 1)} 
            > 
              Previous 
            </Button> 
 
            <Button 
              variant="secondary" 
              disabled={page >= totalPages} 
              onClick={() => setPage((p) => p + 1)} 
            > 
              Next 
            </Button> 
          </div> 
        </div> 
      )} 
 
      {showNew && ( 
        <NewCaseDialog 
          onClose={() => setShowNew(false)} 
          onCreated={() => { 
            setShowNew(false); 
            load(); 
          }} 
        /> 
      )} 
    </div> 
  ); 
} 
 
