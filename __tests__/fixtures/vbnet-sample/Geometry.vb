Imports System
Imports System.Collections.Generic
Imports VbnetSample.Shapes

Namespace Geometry

    ''' <summary>
    ''' Stateless geometry helpers. A VB `Module` — its members are implicitly
    ''' Shared, so this exercises the Module -> `kind='module'` mapping.
    ''' </summary>
    Public Module ShapeMath

        ''' <summary>Sums the area of every shape in a sequence.</summary>
        Public Function TotalArea(items As IEnumerable(Of IShape)) As Double
            Dim sum As Double = 0
            For Each item In items
                sum += item.Area()
            Next
            Return sum
        End Function

        ''' <summary>Writes one shape's area to the console.</summary>
        Public Sub PrintArea(shape As IShape)
            Console.WriteLine(shape.Name & ": " & shape.Area().ToString())
        End Sub

    End Module

End Namespace
