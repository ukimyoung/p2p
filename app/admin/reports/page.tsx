import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { isReportAdmin } from '../../../lib/admin-reports';
import { getSession } from '../../../lib/data-store';
import { memberById } from '../../../lib/email-auth';
import AdminReports from './reports-client';
import './reports.css';

export default async function ReportsPage() {
  const cookieStore=await cookies();
  const address=await getSession(cookieStore.get('peer_session')?.value);
  if(!isReportAdmin(address)||!address||!await memberById(address)) notFound();
  return <AdminReports />;
}
