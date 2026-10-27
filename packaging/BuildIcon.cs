using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using System.Xml;

// Offline format conversion, not a replacement drawing. Geometry and colors come
// exclusively from src/ui/icon.svg. Unsupported SVG content fails closed.
internal static class BuildIcon
{
    static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    static readonly int[] Sizes = { 16, 20, 24, 32, 40, 48, 64, 128, 256 };
    static float Number(string value) { return float.Parse(value, Invariant); }
    static float Attribute(XmlElement e, string name, string fallback)
    { return Number(e.HasAttribute(name) ? e.GetAttribute(name) : fallback); }

    static GraphicsPath SvgPath(string data)
    {
        MatchCollection matches = Regex.Matches(data, @"[MmLlHhVvCcZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?");
        if (Regex.Replace(data, @"[MmLlHhVvCcZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]", "") != "")
            throw new InvalidDataException("Unsupported SVG path command; use a full SVG renderer before changing the source artwork.");
        List<string> tokens = new List<string>();
        foreach (Match m in matches) tokens.Add(m.Value);
        GraphicsPath result = new GraphicsPath(FillMode.Winding);
        float x = 0, y = 0, startX = 0, startY = 0;
        char command = '\0';
        int i = 0;
        while (i < tokens.Count)
        {
            if (char.IsLetter(tokens[i][0])) command = tokens[i++][0];
            bool relative = char.IsLower(command);
            char kind = char.ToUpperInvariant(command);
            if (kind == 'Z')
            { result.CloseFigure(); x = startX; y = startY; command = '\0'; continue; }
            int count = kind == 'C' ? 6 : (kind == 'M' || kind == 'L') ? 2 : (kind == 'H' || kind == 'V') ? 1 : 0;
            if (count == 0 || i + count > tokens.Count) throw new InvalidDataException("Invalid SVG path.");
            float[] values = new float[count];
            for (int n = 0; n < count; n++) values[n] = Number(tokens[i++]);
            float nx = x, ny = y;
            if (kind == 'M' || kind == 'L')
            { nx = values[0] + (relative ? x : 0); ny = values[1] + (relative ? y : 0); }
            if (kind == 'H') nx = values[0] + (relative ? x : 0);
            if (kind == 'V') ny = values[0] + (relative ? y : 0);
            if (kind == 'M')
            { result.StartFigure(); startX = nx; startY = ny; command = relative ? 'l' : 'L'; }
            else if (kind == 'C')
            {
                float dx = relative ? x : 0, dy = relative ? y : 0;
                nx = values[4] + dx; ny = values[5] + dy;
                result.AddBezier(x, y, values[0] + dx, values[1] + dy, values[2] + dx, values[3] + dy, nx, ny);
            }
            else result.AddLine(x, y, nx, ny);
            x = nx; y = ny;
        }
        return result;
    }

    static void ValidateAttributes(XmlElement element, string allowed)
    {
        foreach (XmlAttribute a in element.Attributes)
            if (a.Name != "xmlns" && Array.IndexOf(allowed.Split(' '), a.Name) < 0)
                throw new InvalidDataException("Unsupported SVG attribute: " + a.Name);
    }

    static byte[] Render(XmlElement svg, int size)
    {
        ValidateAttributes(svg, "viewBox");
        string[] view = svg.GetAttribute("viewBox").Split(new char[] { ' ', ',' }, StringSplitOptions.RemoveEmptyEntries);
        if (view.Length != 4 || Number(view[2]) != Number(view[3]) || Number(view[2]) <= 0)
            throw new InvalidDataException("Expected a square SVG viewBox.");
        using (Bitmap high = new Bitmap(size * 4, size * 4, PixelFormat.Format32bppArgb))
        using (Graphics g = Graphics.FromImage(high))
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float scale = size * 4 / Number(view[2]);
            g.ScaleTransform(scale, scale);
            g.TranslateTransform(-Number(view[0]), -Number(view[1]));
            foreach (XmlNode node in svg.ChildNodes)
            {
                XmlElement e = node as XmlElement;
                if (e == null) continue;
                string fill = e.GetAttribute("fill");
                if (!Regex.IsMatch(fill, "^#[0-9a-fA-F]{6}$")) throw new InvalidDataException("Expected a literal RGB fill.");
                using (Brush brush = new SolidBrush(ColorTranslator.FromHtml(fill)))
                {
                    if (e.LocalName == "path")
                    {
                        ValidateAttributes(e, "d fill");
                        using (GraphicsPath shape = SvgPath(e.GetAttribute("d"))) g.FillPath(brush, shape);
                    }
                    else if (e.LocalName == "circle")
                    {
                        ValidateAttributes(e, "cx cy r fill");
                        float r = Attribute(e, "r", "0"), x = Attribute(e, "cx", "0"), y = Attribute(e, "cy", "0");
                        g.FillEllipse(brush, x - r, y - r, r * 2, r * 2);
                    }
                    else if (e.LocalName == "rect")
                    {
                        ValidateAttributes(e, "x y width height rx fill");
                        float x = Attribute(e, "x", "0"), y = Attribute(e, "y", "0"), w = Attribute(e, "width", "0"), h = Attribute(e, "height", "0");
                        float radius = Math.Min(Attribute(e, "rx", "0"), Math.Min(w, h) / 2), d = radius * 2;
                        if (d == 0) g.FillRectangle(brush, x, y, w, h);
                        else using (GraphicsPath shape = new GraphicsPath())
                        {
                            shape.AddArc(x, y, d, d, 180, 90);
                            shape.AddArc(x + w - d, y, d, d, 270, 90);
                            shape.AddArc(x + w - d, y + h - d, d, d, 0, 90);
                            shape.AddArc(x, y + h - d, d, d, 90, 90);
                            shape.CloseFigure(); g.FillPath(brush, shape);
                        }
                    }
                    else throw new InvalidDataException("Unsupported SVG element: " + e.LocalName);
                }
            }
            using (Bitmap output = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            using (Graphics final = Graphics.FromImage(output))
            using (MemoryStream stream = new MemoryStream())
            {
                final.CompositingMode = CompositingMode.SourceCopy;
                final.InterpolationMode = InterpolationMode.HighQualityBicubic;
                final.PixelOffsetMode = PixelOffsetMode.HighQuality;
                using (ImageAttributes attributes = new ImageAttributes())
                {
                    attributes.SetWrapMode(WrapMode.TileFlipXY);
                    final.DrawImage(high, new Rectangle(0, 0, size, size), 0, 0, high.Width, high.Height, GraphicsUnit.Pixel, attributes);
                }
                output.Save(stream, ImageFormat.Png);
                return stream.ToArray();
            }
        }
    }

    static int Main(string[] args)
    {
        try
        {
            if (args.Length != 3) throw new ArgumentException("BuildIcon <original.svg> <output.ico> <preview.png>");
            XmlReaderSettings settings = new XmlReaderSettings();
            settings.DtdProcessing = DtdProcessing.Prohibit;
            settings.XmlResolver = null;
            XmlDocument document = new XmlDocument();
            document.XmlResolver = null;
            using (XmlReader reader = XmlReader.Create(args[0], settings)) document.Load(reader);
            XmlElement svg = document.DocumentElement;
            if (svg.LocalName != "svg") throw new InvalidDataException("Expected SVG source.");
            List<byte[]> images = new List<byte[]>();
            foreach (int size in Sizes) images.Add(Render(svg, size));
            using (BinaryWriter writer = new BinaryWriter(File.Create(args[1])))
            {
                writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)Sizes.Length);
                int offset = 6 + 16 * Sizes.Length;
                for (int i = 0; i < Sizes.Length; i++)
                {
                    writer.Write((byte)(Sizes[i] == 256 ? 0 : Sizes[i])); writer.Write((byte)(Sizes[i] == 256 ? 0 : Sizes[i]));
                    writer.Write((byte)0); writer.Write((byte)0); writer.Write((ushort)1); writer.Write((ushort)32);
                    writer.Write(images[i].Length); writer.Write(offset); offset += images[i].Length;
                }
                foreach (byte[] image in images) writer.Write(image);
            }
            File.WriteAllBytes(args[2], Render(svg, 256));
            Console.WriteLine("Converted original SVG into a 9-size Windows icon; original SVG unchanged.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
