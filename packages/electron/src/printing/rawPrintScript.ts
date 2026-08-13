/**
 * PowerShell shim that pushes a byte buffer through the Windows print spooler
 * with the RAW datatype.
 *
 * A driver-rendered job would rasterize our ESC/POS or ZPL into a bitmap and the
 * printer would spit out gibberish, so the bytes have to bypass the driver's
 * rendering path. The supported way to do that is winspool's
 * OpenPrinter/StartDocPrinter("RAW")/WritePrinter sequence, which we reach by
 * P/Invoke from a compiled-on-demand C# type. That keeps USB printing working
 * without a native Node addon — this project already rebuilds better-sqlite3
 * against two ABIs, and a second native dependency is not worth the cost.
 */
export const RAW_PRINT_SCRIPT = `param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$FilePath,
  [string]$DocumentName = "Jingles POS"
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class JinglesRawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DOCINFOW
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOW di);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static int Send(string printerName, byte[] payload, string documentName)
    {
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
        {
            throw new Exception("OpenPrinter failed for '" + printerName + "' (error " + Marshal.GetLastWin32Error() + ")");
        }

        try
        {
            DOCINFOW info = new DOCINFOW();
            info.pDocName = documentName;
            info.pOutputFile = null;
            info.pDatatype = "RAW";

            if (!StartDocPrinter(hPrinter, 1, ref info))
            {
                throw new Exception("StartDocPrinter failed (error " + Marshal.GetLastWin32Error() + ")");
            }

            try
            {
                if (!StartPagePrinter(hPrinter))
                {
                    throw new Exception("StartPagePrinter failed (error " + Marshal.GetLastWin32Error() + ")");
                }

                IntPtr buffer = Marshal.AllocCoTaskMem(payload.Length);
                try
                {
                    Marshal.Copy(payload, 0, buffer, payload.Length);
                    int written = 0;
                    if (!WritePrinter(hPrinter, buffer, payload.Length, out written))
                    {
                        throw new Exception("WritePrinter failed (error " + Marshal.GetLastWin32Error() + ")");
                    }

                    EndPagePrinter(hPrinter);
                    return written;
                }
                finally
                {
                    Marshal.FreeCoTaskMem(buffer);
                }
            }
            finally
            {
                EndDocPrinter(hPrinter);
            }
        }
        finally
        {
            ClosePrinter(hPrinter);
        }
    }
}
"@

$payload = [System.IO.File]::ReadAllBytes($FilePath)
$written = [JinglesRawPrinter]::Send($PrinterName, $payload, $DocumentName)
Write-Output $written
`;
