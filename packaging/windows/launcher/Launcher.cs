// Lanzador de bandeja del sistema para aula-local.
// Compilar con build.ps1 (C# 5, .NET Framework 4.x, WinForms).
using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AulaLocal
{
    // Rutas de la instalación y de datos del usuario.
    internal sealed class Rutas
    {
        public readonly string BaseDir;
        public readonly string Node;
        public readonly string Script;
        public readonly string Icono;
        public readonly string DataDir;
        public readonly string LogsDir;
        public readonly string RunDir;
        public readonly string LogFile;
        public readonly string PortFile;

        public Rutas()
        {
            BaseDir = Application.StartupPath;
            Node = Path.Combine(BaseDir, "node", "node.exe");
            Script = Path.Combine(BaseDir, "app", "dist", "server", "index.js");
            Icono = Path.Combine(BaseDir, "aula-local.ico");

            string raiz = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "aula-local");
            DataDir = Path.Combine(raiz, "data");
            LogsDir = Path.Combine(raiz, "logs");
            RunDir = Path.Combine(raiz, "run");
            LogFile = Path.Combine(LogsDir, "server.log");
            PortFile = Path.Combine(RunDir, "port.txt");
        }
    }

    // Registro de texto con marca de tiempo; seguro entre hilos.
    internal sealed class RegistroLog
    {
        private readonly object candado = new object();
        private readonly string ruta;

        public RegistroLog(string ruta)
        {
            this.ruta = ruta;
        }

        // Si el registro supera 1 MB, lo mueve a server.old.log.
        public void RotarSiEsGrande()
        {
            try
            {
                if (File.Exists(ruta) && new FileInfo(ruta).Length > 1024 * 1024)
                {
                    string viejo = Path.Combine(Path.GetDirectoryName(ruta), "server.old.log");
                    lock (candado)
                    {
                        if (File.Exists(viejo)) File.Delete(viejo);
                        File.Move(ruta, viejo);
                    }
                }
            }
            catch (Exception) { }
        }

        public void Escribir(string linea)
        {
            string texto = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + linea + Environment.NewLine;
            lock (candado)
            {
                try { File.AppendAllText(ruta, texto, Encoding.UTF8); }
                catch (Exception) { }
            }
        }
    }

    // Utilidades: puertos, token, navegador y el modo --salir.
    internal static class Utiles
    {
        public const string NombreMutex = "Local\\aula-local-launcher";
        public const string NombreEventoSalir = "Local\\aula-local-salir";
        public const int PuertoInicial = 3000;
        public const int PuertoFinal = 3010;

        // Primer puerto libre entre 3000 y 3010, o -1 si no hay ninguno.
        public static int ElegirPuerto()
        {
            for (int p = PuertoInicial; p <= PuertoFinal; p++)
            {
                try
                {
                    TcpListener l = new TcpListener(IPAddress.Any, p);
                    l.Start();
                    l.Stop();
                    return p;
                }
                catch (Exception) { }
            }
            return -1;
        }

        // Token aleatorio de 32 bytes en hexadecimal.
        public static string GenerarToken()
        {
            byte[] bytes = new byte[32];
            using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider())
            {
                rng.GetBytes(bytes);
            }
            StringBuilder sb = new StringBuilder(64);
            foreach (byte b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        // Puerto guardado por la instancia en ejecución (por defecto 3000).
        public static int LeerPuerto(Rutas rutas)
        {
            try
            {
                int v;
                if (File.Exists(rutas.PortFile) && int.TryParse(File.ReadAllText(rutas.PortFile).Trim(), out v))
                    return v;
            }
            catch (Exception) { }
            return PuertoInicial;
        }

        public static void AbrirUrl(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch (Exception) { }
        }

        // Comprueba que el servidor responda 200 en /api/pin/status.
        public static bool Responde(int puerto)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + puerto + "/api/pin/status");
                req.Method = "GET";
                req.Timeout = 2000;
                req.Proxy = null;
                req.KeepAlive = false;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        // Modo --salir: pide a la instancia en ejecución que se cierre y espera hasta 15 s.
        public static int PedirSalida()
        {
            bool creado;
            using (Mutex m = new Mutex(false, NombreMutex, out creado))
            {
                // No había instancia en ejecución.
                if (creado) return 0;

                try
                {
                    EventWaitHandle ev = EventWaitHandle.OpenExisting(NombreEventoSalir);
                    ev.Set();
                    ev.Close();
                }
                catch (Exception) { }

                bool libre;
                try { libre = m.WaitOne(15000); }
                catch (AbandonedMutexException) { libre = true; }

                if (libre) m.ReleaseMutex();
                return libre ? 0 : 1;
            }
        }
    }

    internal static class Programa
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (args.Length > 0 && args[0] == "--salir")
                return Utiles.PedirSalida();

            bool propietario;
            Mutex mutex = new Mutex(true, Utiles.NombreMutex, out propietario);
            try
            {
                if (!propietario)
                {
                    // Ya hay una instancia: solo abrir Mis clases.
                    Rutas r = new Rutas();
                    Utiles.AbrirUrl("http://localhost:" + Utiles.LeerPuerto(r) + "/teacher/clases");
                    return 0;
                }

                Rutas rutas = new Rutas();
                string faltan = "";
                if (!File.Exists(rutas.Node)) faltan += rutas.Node + "\n";
                if (!File.Exists(rutas.Script)) faltan += rutas.Script + "\n";
                if (faltan.Length > 0)
                {
                    MessageBox.Show("No se encontró la instalación de aula-local. Faltan:\n\n" + faltan,
                        "aula-local", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }

                try
                {
                    Directory.CreateDirectory(rutas.DataDir);
                    Directory.CreateDirectory(rutas.LogsDir);
                    Directory.CreateDirectory(rutas.RunDir);
                }
                catch (Exception ex)
                {
                    MessageBox.Show("No se pudieron crear las carpetas de aula-local:\n" + ex.Message,
                        "aula-local", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }

                // Evento para --salir. No se libera: lo usa el hilo de escucha hasta cerrar.
                EventWaitHandle evSalir = new EventWaitHandle(false, EventResetMode.AutoReset, Utiles.NombreEventoSalir);
                Application.Run(new ContextoBandeja(rutas, evSalir));
                return 0;
            }
            finally
            {
                if (propietario) mutex.ReleaseMutex();
                mutex.Close();
            }
        }
    }

    // Contexto sin ventana: icono en la bandeja y control del proceso node.
    internal sealed class ContextoBandeja : ApplicationContext
    {
        private readonly Rutas rutas;
        private readonly RegistroLog log;
        private readonly Control ui;                 // control oculto para marshal al hilo de UI
        private readonly NotifyIcon bandeja;
        private readonly ToolStripMenuItem itemPrincipal;
        private readonly object candadoSalida = new object();
        private readonly ManualResetEvent salidaTerminada = new ManualResetEvent(false);

        private volatile Process proceso;
        private volatile bool servidorArriba;
        private volatile bool cerrando;
        private int puerto;
        private string token;

        public ContextoBandeja(Rutas rutas, EventWaitHandle evSalir)
        {
            this.rutas = rutas;
            log = new RegistroLog(rutas.LogFile);
            log.RotarSiEsGrande();

            ui = new Control();
            IntPtr manija = ui.Handle; // fuerza la creación del handle en este hilo

            itemPrincipal = new ToolStripMenuItem("Abrir Mis clases", null, delegate { AlPrincipal(); });

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add(itemPrincipal);
            menu.Items.Add(new ToolStripMenuItem("Conectar alumnos", null, delegate { AbrirSiArriba("/teacher/conectar"); }));
            menu.Items.Add(new ToolStripMenuItem("Guía de red", null, delegate { AbrirSiArriba("/teacher/guia-red"); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Ver registro", null, delegate { VerRegistro(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Salir", null, delegate { SolicitarSalida(); }));

            bandeja = new NotifyIcon();
            bandeja.Icon = CargarIcono(rutas.Icono);
            bandeja.Text = "aula-local";
            bandeja.ContextMenuStrip = menu;
            bandeja.DoubleClick += delegate { AlPrincipal(); };
            bandeja.Visible = true;

            // Cierre de sesión de Windows: apagar el servidor antes de que termine.
            SystemEvents.SessionEnding += delegate
            {
                SolicitarSalida();
                salidaTerminada.WaitOne(15000);
            };

            // Hilo que espera la señal de --salir.
            Thread hiloSalir = new Thread(new ThreadStart(delegate
            {
                while (true)
                {
                    evSalir.WaitOne();
                    SolicitarSalida();
                }
            }));
            hiloSalir.IsBackground = true;
            hiloSalir.Start();

            IniciarServidor();
        }

        // Arranca node con un puerto libre y un token nuevo.
        private bool IniciarServidor()
        {
            int candidato = Utiles.ElegirPuerto();
            if (candidato < 0)
            {
                FallarArranque("No hay puertos libres entre 3000 y 3010.");
                return false;
            }
            puerto = candidato;
            token = Utiles.GenerarToken();

            try
            {
                File.WriteAllText(rutas.PortFile, puerto.ToString(CultureInfo.InvariantCulture), Encoding.ASCII);
            }
            catch (Exception ex)
            {
                log.Escribir("[launcher] No se pudo escribir port.txt: " + ex.Message);
            }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = rutas.Node;
            psi.Arguments = "\"" + rutas.Script + "\"";
            psi.WorkingDirectory = Path.Combine(rutas.BaseDir, "app");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.EnvironmentVariables["PORT"] = puerto.ToString(CultureInfo.InvariantCulture);
            psi.EnvironmentVariables["AULA_DATA_DIR"] = rutas.DataDir;
            psi.EnvironmentVariables["AULA_SHUTDOWN_TOKEN"] = token;

            Process p = new Process();
            p.StartInfo = psi;
            p.EnableRaisingEvents = true;
            p.Exited += OnProcesoTerminado;
            p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) log.Escribir(e.Data);
            };
            p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) log.Escribir("[stderr] " + e.Data);
            };

            proceso = p;
            try
            {
                p.Start();
            }
            catch (Exception ex)
            {
                proceso = null;
                FallarArranque("No se pudo iniciar el servidor: " + ex.Message);
                return false;
            }
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();

            log.Escribir("[launcher] Servidor iniciado en puerto " + puerto + " (pid " + p.Id + ")");
            servidorArriba = true;
            itemPrincipal.Text = "Abrir Mis clases";

            int puertoLocal = puerto;
            Thread hilo = new Thread(new ThreadStart(delegate { EsperarListo(p, puertoLocal); }));
            hilo.IsBackground = true;
            hilo.Start();
            return true;
        }

        private void FallarArranque(string texto)
        {
            servidorArriba = false;
            itemPrincipal.Text = "Reiniciar aula-local";
            log.Escribir("[launcher] " + texto);
            bandeja.ShowBalloonTip(4000, "aula-local", texto, ToolTipIcon.Error);
        }

        // Hilo de fondo: sondea /api/pin/status hasta 20 s.
        private void EsperarListo(Process p, int puertoServidor)
        {
            DateTime limite = DateTime.UtcNow.AddSeconds(20);
            while (DateTime.UtcNow < limite)
            {
                if (cerrando || HaTerminado(p)) return;
                if (Utiles.Responde(puertoServidor))
                {
                    ui.BeginInvoke(new MethodInvoker(delegate { ServidorListo(p, puertoServidor); }));
                    return;
                }
                Thread.Sleep(300);
            }

            if (!cerrando && !HaTerminado(p))
            {
                ui.BeginInvoke(new MethodInvoker(delegate
                {
                    if (!cerrando && p == proceso)
                        bandeja.ShowBalloonTip(4000, "aula-local", "aula-local tarda en arrancar. Revisa el registro.", ToolTipIcon.Warning);
                }));
            }
        }

        private void ServidorListo(Process p, int puertoServidor)
        {
            if (cerrando || p != proceso) return;
            Utiles.AbrirUrl("http://localhost:" + puertoServidor + "/teacher/clases");
            bandeja.ShowBalloonTip(2000, "aula-local", "aula-local está listo", ToolTipIcon.Info);
        }

        // Llamado por el evento Exited de node (hilo de fondo).
        private void OnProcesoTerminado(object sender, EventArgs e)
        {
            Process p = sender as Process;
            if (cerrando || p == null || p != proceso) return;
            ui.BeginInvoke(new MethodInvoker(delegate { ServidorSeDetuvo(p); }));
        }

        private void ServidorSeDetuvo(Process p)
        {
            if (cerrando || p != proceso) return;
            servidorArriba = false;
            int codigo = -1;
            try { codigo = p.ExitCode; } catch (Exception) { }
            log.Escribir("[launcher] El servidor terminó con código " + codigo);
            bandeja.ShowBalloonTip(4000, "aula-local", "aula-local se detuvo", ToolTipIcon.Warning);
            itemPrincipal.Text = "Reiniciar aula-local";
        }

        // Doble clic o primer elemento del menú: abre Mis clases, o reinicia si está caído.
        private void AlPrincipal()
        {
            if (servidorArriba)
                Utiles.AbrirUrl("http://localhost:" + puerto + "/teacher/clases");
            else
                IniciarServidor();
        }

        private void AbrirSiArriba(string ruta)
        {
            if (servidorArriba)
                Utiles.AbrirUrl("http://localhost:" + puerto + ruta);
            else
                bandeja.ShowBalloonTip(3000, "aula-local", "aula-local no está en marcha. Usa Reiniciar aula-local.", ToolTipIcon.Warning);
        }

        private void VerRegistro()
        {
            try { Process.Start(new ProcessStartInfo("notepad.exe", "\"" + rutas.LogFile + "\"")); }
            catch (Exception ex) { log.Escribir("[launcher] No se pudo abrir el registro: " + ex.Message); }
        }

        // Inicia el cierre en un hilo de fondo (una sola vez).
        private void SolicitarSalida()
        {
            lock (candadoSalida)
            {
                if (cerrando) return;
                cerrando = true;
            }
            Thread hilo = new Thread(new ThreadStart(TrabajoSalida));
            hilo.IsBackground = true;
            hilo.Start();
        }

        private void TrabajoSalida()
        {
            try
            {
                DetenerNodo();
                ui.Invoke(new MethodInvoker(FinalizarSalida));
            }
            catch (Exception ex)
            {
                log.Escribir("[launcher] Error al salir: " + ex.Message);
                Environment.Exit(0);
            }
            finally
            {
                salidaTerminada.Set();
            }
        }

        // Pide el apagado por HTTP, espera 10 s y fuerza el cierre si sigue vivo.
        private void DetenerNodo()
        {
            Process p = proceso;
            if (p == null || HaTerminado(p)) return;

            PedirApagado(puerto, token);
            if (!p.WaitForExit(10000))
            {
                log.Escribir("[launcher] El servidor no terminó a tiempo; se fuerza el cierre.");
                try { p.Kill(); } catch (Exception) { }
            }
        }

        private void PedirApagado(int puertoServidor, string tok)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + puertoServidor + "/api/app/shutdown");
                req.Method = "POST";
                req.Timeout = 5000;
                req.Proxy = null;
                req.KeepAlive = false;
                req.ContentLength = 0;
                req.Headers["X-Aula-Token"] = tok;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    log.Escribir("[launcher] Apagado solicitado; respuesta " + (int)resp.StatusCode);
                }
            }
            catch (Exception ex)
            {
                log.Escribir("[launcher] Apagado no confirmado: " + ex.Message);
            }
        }

        // Se ejecuta en el hilo de UI: quita el icono y termina el hilo de mensajes.
        private void FinalizarSalida()
        {
            bandeja.Visible = false;
            bandeja.Dispose();
            try
            {
                if (File.Exists(rutas.PortFile)) File.Delete(rutas.PortFile);
            }
            catch (Exception) { }
            log.Escribir("[launcher] aula-local cerrado.");
            ExitThread();
        }

        private static bool HaTerminado(Process p)
        {
            try { return p.HasExited; }
            catch (Exception) { return true; }
        }

        private static Icon CargarIcono(string ruta)
        {
            try
            {
                if (File.Exists(ruta)) return new Icon(ruta);
            }
            catch (Exception) { }
            return SystemIcons.Application;
        }
    }
}
