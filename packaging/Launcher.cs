using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;
using System.Drawing;

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool selfTest = args.Length > 0 && args[0] == "--self-test";
        try
        {
            if (selfTest && args.Length != 2)
                throw new ArgumentException("用法：鲁滨逊.exe --self-test <报告路径>");
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string app = Path.Combine(root, "app");
            string node = Path.Combine(root, "runtime", "node.exe");
            string script = Path.Combine(app, "scripts", selfTest ? "package-self-test.mjs" : "robinson.mjs");
            if (!File.Exists(node) || !File.Exists(script))
                throw new FileNotFoundException("应用文件不完整。请先完整解压下载的 ZIP，再双击其中的鲁滨逊.exe；不要单独移动 EXE。");

            string arguments = Quote(script);
            if (selfTest)
                arguments += " " + Quote(Path.GetFullPath(args[1]));
            else
                foreach (string argument in args) arguments += " " + Quote(argument);
            ProcessStartInfo start = new ProcessStartInfo(node, arguments);
            start.WorkingDirectory = app;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.RedirectStandardInput = !selfTest;
            start.EnvironmentVariables["ROBINSON_PACKAGED"] = "1";
            StringBuilder errors = new StringBuilder();
            using (Process process = new Process())
            {
                process.StartInfo = start;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data == null) return;
                    lock (errors)
                    {
                        errors.AppendLine(e.Data);
                        if (errors.Length > 6000) errors.Remove(0, errors.Length - 6000);
                    }
                };
                if (!process.Start()) throw new InvalidOperationException("无法启动内置运行环境。");
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                if (selfTest) process.WaitForExit();
                else
                {
                    Application.EnableVisualStyles();
                    using (NotifyIcon tray = new NotifyIcon())
                    using (System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer())
                    {
                        tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                        tray.Text = "鲁滨逊 · 微信助手";
                        ContextMenuStrip menu = new ContextMenuStrip();
                        Action<string> command = delegate(string value) {
                            try { if (!process.HasExited) { process.StandardInput.WriteLine(value); process.StandardInput.Flush(); } }
                            catch (IOException) { }
                        };
                        menu.Items.Add("打开鲁滨逊", null, delegate { command("open"); });
                        menu.Items.Add("安全退出（等待任务结束）", null, delegate { command("stop"); });
                        tray.ContextMenuStrip = menu;
                        tray.DoubleClick += delegate { command("open"); };
                        tray.Visible = true;
                        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                            if (e.Data != null && e.Data.StartsWith("STATUS\t"))
                            {
                                lock (errors) { errors.AppendLine(e.Data.Substring(7)); }
                            }
                        };
                        string lastNotice = "";
                        timer.Interval = 500;
                        timer.Tick += delegate {
                            if (process.HasExited) { timer.Stop(); tray.Visible = false; Application.ExitThread(); return; }
                            string text; lock (errors) { text = errors.ToString(); }
                            if (text != lastNotice && text.Length > 0) {
                                lastNotice = text;
                                tray.ShowBalloonTip(4000, "鲁滨逊", text.Length > 240 ? text.Substring(text.Length-240) : text, ToolTipIcon.Info);
                            }
                        };
                        timer.Start();
                        Application.Run();
                        process.WaitForExit();
                    }
                }
                if (process.ExitCode != 0 && !selfTest)
                    MessageBox.Show("鲁滨逊未能正常启动或已经退出。\n\n" + errors.ToString(), "鲁滨逊", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            if (selfTest)
            {
                if (args.Length == 2)
                {
                    try
                    {
                        string report = Path.GetFullPath(args[1]);
                        Directory.CreateDirectory(Path.GetDirectoryName(report));
                        File.WriteAllText(report, "{\"ok\":false,\"launcherError\":\"" + JsonEscape(error.Message) + "\"}", new UTF8Encoding(false));
                    }
                    catch { }
                }
            }
            else
                MessageBox.Show(error.Message, "鲁滨逊无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    // Windows command-line quoting preserves spaces, quotes and trailing slashes.
    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
                result.Append('\\', slashes * 2 + 1).Append('"');
            else
                result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static string JsonEscape(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t");
    }
}
