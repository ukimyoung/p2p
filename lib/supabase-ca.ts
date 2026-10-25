// Public production roots from supabase/cli commit 466485003e9fc4a3c15bf80b5369fddba65c2846.
// Keep both roots while Supabase rotates server certificates.
import root2021 from './certs/supabase-prod-ca-2021';
import root2025 from './certs/supabase-prod-ca-2025';

export const supabaseRootCAs=[root2021,root2025];
